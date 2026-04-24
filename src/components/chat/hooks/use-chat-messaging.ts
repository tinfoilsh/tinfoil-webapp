/**
 * Chat messaging hook
 *
 * Responsibilities:
 * - Orchestrates user input → persistence, network streaming, and UI state
 * - Delegates heavy-lift to:
 *   - persistence: hooks/chat-persistence.ts (local/IndexedDB + cloud sync gating)
 *   - network: services/inference (request builder + fetch in inference-client)
 *   - streaming: hooks/streaming-processor.ts (SSE parsing and thinking mode)
 *
 * State invariants:
 * - currentChatIdRef always mirrors the canonical chat id (temporary → server id swaps)
 * - isStreamingRef is true only while processing an assistant response (used to defer cloud sync)
 * - thinkingStartTimeRef is set only while a model is in thinking/reasoning mode
 */
import { useProject } from '@/components/project'
import { type BaseModel } from '@/config/models'
import { sendChatStream } from '@/services/inference/inference-client'
import {
  getRateLimitInfo,
  refreshRateLimit,
} from '@/services/inference/tinfoil-client'
import { generateTitle } from '@/services/inference/title'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMessageAttachments } from '../attachment-helpers'
import { CONSTANTS } from '../constants'
import type { Chat, LoadingState, Message } from '../types'
import { createBlankChat, sortChats } from './chat-operations'
import { createUpdateChatWithHistoryCheck } from './chat-persistence'
import { processStreamingResponse } from './streaming'
import { useMaxMessages } from './use-max-messages'
import type { ReasoningEffort } from './use-reasoning-effort'

interface UseChatMessagingProps {
  systemPrompt: string
  rules?: string
  storeHistory: boolean
  models: BaseModel[]
  selectedModel: string
  chats: Chat[]
  currentChat: Chat
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>
  messagesEndRef: React.RefObject<HTMLDivElement>
  scrollToBottom?: () => void
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  webSearchEnabled?: boolean
  piiCheckEnabled?: boolean
}

interface UseChatMessagingReturn {
  input: string
  loadingState: LoadingState
  retryInfo: { attempt: number; maxRetries: number; error?: string } | null
  inputRef: React.RefObject<HTMLTextAreaElement>
  isThinking: boolean
  isWaitingForResponse: boolean
  isStreaming: boolean
  streamError: string | null
  dismissStreamError: () => void
  setInput: (input: string) => void
  handleSubmit: (e: React.FormEvent) => void
  handleQuery: (
    query: string,
    attachments?: import('@/components/chat/types').Attachment[],
    systemPromptOverride?: string,
    baseMessages?: Message[],
    quote?: string,
  ) => void
  cancelGeneration: () => Promise<void>
  editMessage: (messageIndex: number, newContent: string) => void
  regenerateMessage: (messageIndex: number) => void
}

export function useChatMessaging({
  systemPrompt,
  rules = '',
  storeHistory,
  models,
  selectedModel,
  chats,
  currentChat,
  setChats,
  setCurrentChat,
  messagesEndRef,
  scrollToBottom,
  reasoningEffort,
  thinkingEnabled,
  webSearchEnabled,
  piiCheckEnabled,
}: UseChatMessagingProps): UseChatMessagingReturn {
  const { isSignedIn } = useAuth()
  const maxMessages = useMaxMessages()
  const { isProjectMode, activeProject } = useProject()

  const [input, setInput] = useState('')
  const [loadingState, setLoadingState] = useState<LoadingState>('idle')
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number
    maxRetries: number
    error?: string
  } | null>(null)
  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)

  const dismissStreamError = useCallback(() => {
    setStreamError(null)
  }, [])

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const currentChatIdRef = useRef<string>(currentChat?.id || '')
  const isStreamingRef = useRef(false)
  const thinkingStartTimeRef = useRef<number | null>(null)
  const earlyTitlePromiseRef = useRef<Promise<string> | null>(null)

  // Helper to calculate thinking duration and reset timer
  const getThinkingDuration = () => {
    const duration = thinkingStartTimeRef.current
      ? (Date.now() - thinkingStartTimeRef.current) / 1000
      : undefined
    thinkingStartTimeRef.current = null
    return duration
  }

  // A modified version of updateChat that respects the storeHistory flag
  // During streaming, we persist to IndexedDB but defer cloud backup unless immediate=true
  // When the backend assigns a new id, we atomically rewrite ids in both currentChat and chats
  const updateChatWithHistoryCheck = useMemo(
    () =>
      createUpdateChatWithHistoryCheck({
        storeHistory,
        isStreamingRef,
        currentChatIdRef,
      }),
    [storeHistory],
  )

  // Cancel generation function
  const cancelGeneration = useCallback(async () => {
    if (abortController) {
      abortController.abort()
      setAbortController(null)
    }
    setLoadingState('idle')
    setRetryInfo(null)
    setIsThinking(false)
    setIsWaitingForResponse(false)
    thinkingStartTimeRef.current = null

    // If we're in thinking mode, remove the last message if it's a thinking message
    if (isStreamingRef.current) {
      setChats((prevChats) => {
        const newChats = prevChats.map((chat) => {
          if (chat.id === currentChatIdRef.current) {
            // Remove the last message if it's a thinking message
            const messages = chat.messages.filter(
              (msg, idx) =>
                !(idx === chat.messages.length - 1 && msg.isThinking),
            )
            return { ...chat, messages, pendingSave: false }
          }
          return chat
        })
        // Find and save the updated chat
        const updatedChat = newChats.find(
          (c) => c.id === currentChatIdRef.current,
        )
        if (updatedChat) {
          if (storeHistory) {
            chatStorage
              .saveChatAndSync(updatedChat)
              .then((savedChat) => {
                // Only update if the ID actually changed
                if (savedChat.id !== updatedChat.id) {
                  currentChatIdRef.current = savedChat.id
                  setCurrentChat(savedChat)
                  setChats((prevChats) =>
                    prevChats.map((c) =>
                      c.id === updatedChat.id ? savedChat : c,
                    ),
                  )
                }
              })
              .catch((error) => {
                logError('Failed to save chat after cancellation', error, {
                  component: 'useChatMessaging',
                })
              })
          } else {
            // Save to session storage for non-signed-in users
            sessionChatStorage.saveChat(updatedChat)
          }
        }
        return newChats
      })

      // Also update current chat
      setCurrentChat((prev) => {
        const messages = prev.messages.filter(
          (msg, idx) => !(idx === prev.messages.length - 1 && msg.isThinking),
        )
        return { ...prev, messages, pendingSave: false }
      })
    }

    // Wait for any pending state updates
    await new Promise((resolve) =>
      setTimeout(resolve, CONSTANTS.ASYNC_STATE_DELAY_MS),
    )
  }, [abortController, storeHistory, setChats, setCurrentChat])

  // Handle chat query
  // Lifecycle overview:
  // 1) Early exits + input reset
  // 2) Optimistic state update with the user message (and server id acquisition if needed)
  // 3) Persist initial state (session or IndexedDB)
  // 4) Start streaming via inference client
  // 5) streaming-processor applies batched updates until completion
  // 6) Finalize: optional title generation, final save
  const handleQuery = useCallback(
    async (
      query: string,
      attachments?: import('@/components/chat/types').Attachment[],
      systemPromptOverride?: string,
      baseMessages?: Message[],
      quote?: string,
    ) => {
      // Allow empty query if systemPromptOverride, attachments, or a quote are provided
      if (
        (!query.trim() &&
          !systemPromptOverride &&
          !attachments?.length &&
          !quote) ||
        loadingState !== 'idle'
      )
        return

      // Safety check - ensure we have a current chat
      if (!currentChat) {
        logError('No current chat available', undefined, {
          component: 'useChatMessaging',
          action: 'handleQuery',
        })
        return
      }

      // Clear input immediately when send button is pressed
      setInput('')

      // Reset textarea height
      if (inputRef.current) {
        inputRef.current.style.height = CONSTANTS.INPUT_MIN_HEIGHT
      }

      const controller = new AbortController()
      setAbortController(controller)
      setLoadingState('loading')
      setIsWaitingForResponse(true)
      setIsStreaming(true)
      setStreamError(null)

      // Only create a user message if there's actual query content
      // When using system prompt override with empty query, skip user message
      const hasUserContent =
        query.trim() !== '' ||
        (attachments && attachments.length > 0) ||
        Boolean(quote)

      const userMessage: Message | null = hasUserContent
        ? {
            role: 'user',
            content: query,
            attachments:
              attachments && attachments.length > 0 ? attachments : undefined,
            timestamp: new Date(),
            quote: quote || undefined,
          }
        : null

      // Track if this is the first message for a blank chat
      let updatedChat = { ...currentChat }
      const isBlankChat = currentChat.isBlankChat === true
      const isFirstMessage = currentChat.messages.length === 0
      let updatedMessages: Message[] = []

      // Reset title generation for new chats
      if (isFirstMessage) {
        earlyTitlePromiseRef.current = null
      }

      // Handle blank chat conversion: create chat immediately with server-valid ID
      if (isBlankChat && storeHistory) {
        logInfo('[handleQuery] Converting blank chat to real chat', {
          component: 'useChatMessaging',
          action: 'handleQuery.blankChatConversion',
          metadata: {
            isLocalOnly: currentChat.isLocalOnly,
            cloudSyncEnabled: isCloudSyncEnabled(),
          },
        })

        // Generate an ID that matches backend expectations: {reverseTimestamp}_{uuid}
        // This avoids temp→server ID rewrite races (URL/currentChat mismatches).
        const { id: chatId } = generateReverseId()
        updatedMessages = userMessage ? [userMessage] : []
        updatedChat = {
          ...currentChat,
          id: chatId,
          title: 'Untitled',
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
          isLocalOnly: currentChat.isLocalOnly || !isCloudSyncEnabled(),
          pendingSave: true,
          projectId:
            isProjectMode && activeProject ? activeProject.id : undefined,
        }

        // Update state immediately for instant UI feedback
        currentChatIdRef.current = chatId
        setCurrentChat(updatedChat)

        // Replace the blank chat with the new real chat
        setChats((prevChats) => {
          // Filter out the current blank chat that we're converting
          const otherBlankChats = prevChats.filter(
            (c) => c.isBlankChat && c.isLocalOnly !== currentChat.isLocalOnly,
          )
          const nonBlankChats = prevChats.filter((c) => !c.isBlankChat)

          // Re-create the blank chat for this mode
          const newBlankChat = createBlankChat(currentChat.isLocalOnly)

          // Sort with blank chats first, then the new chat, then other chats
          return sortChats([
            ...otherBlankChats,
            newBlankChat,
            updatedChat,
            ...nonBlankChats,
          ])
        })

        // Scroll after state update and DOM renders
        if (scrollToBottom) {
          setTimeout(() => scrollToBottom(), 50)
        }

        // Save immediately (and sync if applicable). ID is already server-valid.
        chatStorage
          .saveChatAndSync(updatedChat)
          .then(() => {
            setChats((prevChats) =>
              prevChats.map((c) =>
                c.id === chatId ? { ...c, pendingSave: false } : c,
              ),
            )
            setCurrentChat((prev) =>
              prev.id === chatId ? { ...prev, pendingSave: false } : prev,
            )
          })
          .catch((error) => {
            logError('[handleQuery] Failed to save new chat', error, {
              component: 'useChatMessaging',
              action: 'handleQuery.initialSaveError',
              metadata: { chatId },
            })
            // Clear pendingSave flag even on error (keeps chat usable locally)
            setChats((prevChats) =>
              prevChats.map((c) =>
                c.id === chatId ? { ...c, pendingSave: false } : c,
              ),
            )
            setCurrentChat((prev) =>
              prev.id === chatId ? { ...prev, pendingSave: false } : prev,
            )
          })
      } else if (isBlankChat && !storeHistory) {
        // For non-signed-in users, create a session chat with a temporary ID
        updatedMessages = userMessage ? [userMessage] : []
        updatedChat = {
          ...currentChat,
          id: `session-${Date.now()}`,
          title: 'Untitled',
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
          pendingSave: true,
        }

        currentChatIdRef.current = updatedChat.id
        setCurrentChat(updatedChat)

        // Replace blank chat with the new chat
        setChats((prevChats) => {
          const otherChats = prevChats.filter((c) => c !== currentChat)
          return [updatedChat, ...otherChats]
        })

        // Scroll after state update and DOM renders
        if (scrollToBottom) {
          setTimeout(() => scrollToBottom(), 50)
        }

        sessionChatStorage.saveChat(updatedChat)

        // Clear pendingSave flag immediately for session storage (it's synchronous)
        setTimeout(() => {
          setChats((prevChats) =>
            prevChats.map((c) =>
              c.id === updatedChat.id ? { ...c, pendingSave: false } : c,
            ),
          )
          setCurrentChat((prev) =>
            prev.id === updatedChat.id ? { ...prev, pendingSave: false } : prev,
          )
        }, 0)
      } else {
        // Not a blank chat, just update messages
        // Use baseMessages if provided (e.g., from editMessage), otherwise use currentChat.messages
        const existingMessages = baseMessages ?? currentChat.messages
        updatedMessages = userMessage
          ? [...existingMessages, userMessage]
          : [...existingMessages]

        updatedChat = {
          ...updatedChat,
          messages: updatedMessages,
        }

        setCurrentChat(updatedChat)
        setChats((prevChats) =>
          prevChats.map((chat) =>
            chat.id === currentChat.id ? updatedChat : chat,
          ),
        )

        // Scroll after state update and DOM renders
        if (scrollToBottom) {
          setTimeout(() => scrollToBottom(), 50)
        }

        // Save the updated chat
        if (storeHistory) {
          await chatStorage.saveChatAndSync(updatedChat)
        } else {
          sessionChatStorage.saveChat(updatedChat)
        }
      }

      // Capture the starting chat ID before any async operations that might change it
      const startingChatId = currentChatIdRef.current

      // Fire title generation in parallel with streaming (based on user's message).
      // The promise is awaited after streaming completes, before the final save.
      if (isFirstMessage && userMessage) {
        const titlePromise = generateTitle([
          { role: 'user', content: userMessage.content || '' },
        ])
        // Prevent unhandled rejection if streaming exits early and the
        // promise is never awaited (e.g. abort, navigation, empty response)
        titlePromise.catch(() => {})
        earlyTitlePromiseRef.current = titlePromise
      }

      // Project memory is currently disabled - uncomment to re-enable
      // Trigger project memory update in parallel with streaming (if in project mode)
      // Uses updatedChat.projectId to avoid race condition if user switches projects during streaming
      // if (updatedChat.projectId && updatedMessages.length > 0) {
      //   projectEvents.emit({
      //     type: 'memory-update-needed',
      //     projectId: updatedChat.projectId,
      //     messages: updatedMessages,
      //   })
      // }

      try {
        const model = models.find((m) => m.modelName === selectedModel)
        if (!model) {
          throw new Error(`Model ${selectedModel} not found`)
        }

        logInfo('[handleQuery] Starting streaming with model', {
          component: 'useChatMessaging',
          action: 'handleQuery.startStreaming',
          metadata: {
            model: selectedModel,
            chatId: currentChatIdRef.current,
            startingChatId,
            isLocalOnly: updatedChat.isLocalOnly,
            messageCount: updatedMessages.length,
          },
        })

        const baseSystemPrompt = systemPromptOverride || systemPrompt
        const response = await sendChatStream({
          model,
          systemPrompt: baseSystemPrompt,
          rules,
          onRetry: (attempt, maxRetries, error) => {
            setLoadingState('retrying')
            setRetryInfo({ attempt, maxRetries, error })
          },
          updatedMessages,
          maxMessages,
          signal: controller.signal,
          reasoningEffort,
          thinkingEnabled,
          webSearchEnabled,
          piiCheckEnabled,
          genUIEnabled: true,
        })

        const assistantMessage = await processStreamingResponse(response, {
          updatedChat,
          updatedMessages,
          isFirstMessage,
          modelsLength: models.length,
          currentChatIdRef,
          isStreamingRef,
          thinkingStartTimeRef,
          setIsThinking,
          setIsWaitingForResponse,
          setIsStreaming,
          updateChatWithHistoryCheck,
          setChats,
          setCurrentChat,
          setLoadingState,
          storeHistory,
          startingChatId,
        })

        if (
          assistantMessage &&
          (assistantMessage.content ||
            assistantMessage.thoughts ||
            assistantMessage.webSearch)
        ) {
          const chatId = currentChatIdRef.current

          // If user navigated away during streaming, don't save to the new chat
          if (chatId !== updatedChat.id) {
            logInfo(
              '[handleQuery] User navigated away during streaming, skipping save',
              {
                component: 'useChatMessaging',
                action: 'handleQuery.navigationDuringStream',
                metadata: {
                  streamingChatId: updatedChat.id,
                  currentChatId: chatId,
                },
              },
            )
            return
          }

          logInfo('[handleQuery] Streaming completed, processing response', {
            component: 'useChatMessaging',
            action: 'handleQuery.streamingComplete',
            metadata: {
              chatId,
              isLocalOnly: updatedChat.isLocalOnly,
              hasContent: !!assistantMessage.content,
              hasThoughts: !!assistantMessage.thoughts,
              isFirstMessage,
            },
          })

          // Always save the response, using the current chat ID from the ref
          // which has been updated to the server ID if one was generated
          const finalMessages = [...updatedMessages, assistantMessage]

          // Resolve title: await the in-flight title gen promise if one exists
          let resolvedTitle = updatedChat.title
          let resolvedTitleState = updatedChat.titleState
          if (
            isFirstMessage &&
            updatedChat.title === 'Untitled' &&
            earlyTitlePromiseRef.current
          ) {
            try {
              const generated = await earlyTitlePromiseRef.current
              if (generated && generated !== 'Untitled') {
                resolvedTitle = generated
                resolvedTitleState = 'generated'
                logInfo('[handleQuery] Title resolved from parallel gen', {
                  component: 'useChatMessaging',
                  action: 'handleQuery.titleResolved',
                  metadata: { chatId, title: resolvedTitle },
                })
              }
            } catch (error) {
              logError('Title generation failed', error, {
                component: 'useChatMessaging',
                action: 'handleQuery.titleGen',
              })
            }
          }

          const chatToSave = {
            ...updatedChat,
            id: chatId,
            title: resolvedTitle,
            titleState: resolvedTitleState,
            messages: finalMessages,
            pendingSave: false,
          }

          // Update React state with resolved title
          setCurrentChat((prev) =>
            prev.id === chatId
              ? {
                  ...prev,
                  title: resolvedTitle,
                  titleState: resolvedTitleState,
                  messages: finalMessages,
                }
              : prev,
          )
          setChats((prevChats) =>
            prevChats.map((c) =>
              c.id === chatId
                ? {
                    ...c,
                    title: resolvedTitle,
                    titleState: resolvedTitleState,
                    messages: finalMessages,
                  }
                : c,
            ),
          )

          // Single save to IndexedDB + cloud sync
          logInfo('[handleQuery] Saving chat after stream', {
            component: 'useChatMessaging',
            action: 'handleQuery.save',
            metadata: {
              chatId,
              isLocalOnly: chatToSave.isLocalOnly,
              title: chatToSave.title,
              messageCount: finalMessages.length,
            },
          })

          updateChatWithHistoryCheck(
            setChats,
            chatToSave,
            setCurrentChat,
            chatId,
            finalMessages,
            false,
          )
        } else {
          logWarning('No assistant content to save after streaming', {
            component: 'useChatMessaging',
            action: 'handleQuery',
          })
        }
      } catch (error) {
        // Ensure UI loading flags are reset on pre-stream errors
        setIsWaitingForResponse(false)
        setIsStreaming(false)
        setLoadingState('idle')
        setIsThinking(false)
        isStreamingRef.current = false
        thinkingStartTimeRef.current = null
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          logError('Chat query failed', error, {
            component: 'useChatMessaging',
            action: 'handleQuery',
          })

          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error occurred'
          const lowerMsg = errorMsg.toLowerCase()
          const isRateLimitError =
            lowerMsg.includes('rate limit') ||
            lowerMsg.includes('request limit') ||
            lowerMsg.includes('insufficient_quota')

          if (isRateLimitError) {
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${errorMsg}`,
              timestamp: new Date(),
              isError: true,
              isRateLimitError: true,
            }

            // Use the current chat ID from ref which has the correct (possibly server) ID
            const currentId = currentChatIdRef.current || updatedChat.id
            updateChatWithHistoryCheck(
              setChats,
              { ...updatedChat, id: currentId, pendingSave: false },
              setCurrentChat,
              currentId,
              [...updatedMessages, errorMessage],
              false,
            )
          } else {
            // Surface as a dismissable floating banner instead of a chat message
            setStreamError(errorMsg)
          }
        }
      } finally {
        // Refresh rate limit from server for free-tier users so the
        // banner/send-blocking reflects the server's actual count
        // (covers both success and error paths, e.g. 429 responses).
        if (getRateLimitInfo() !== null) {
          refreshRateLimit()
        }

        // Ensure loading state is reset regardless of where failure occurs
        setLoadingState('idle')
        setRetryInfo(null)
        setAbortController(null)
      }
    },
    [
      loadingState,
      currentChat,
      storeHistory,
      setChats,
      setCurrentChat,
      models,
      selectedModel,
      systemPrompt,
      maxMessages,
      rules,
      updateChatWithHistoryCheck,
      scrollToBottom,
      reasoningEffort,
      thinkingEnabled,
      isProjectMode,
      activeProject,
      webSearchEnabled,
      piiCheckEnabled,
    ],
  )

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      e.stopPropagation()
      handleQuery(input)
    },
    [input, handleQuery],
  )

  // Edit a message and re-submit - truncates conversation after the edited message
  const editMessage = useCallback(
    (messageIndex: number, newContent: string) => {
      if (loadingState !== 'idle' || !currentChat) return

      const originalMessage = currentChat.messages[messageIndex]
      if (!originalMessage || originalMessage.role !== 'user') return

      // Truncate messages to just before the edited message
      const truncatedMessages = currentChat.messages.slice(0, messageIndex)

      // Re-submit with the new content, passing truncated messages as base
      // handleQuery will handle state updates and persistence
      // Use getMessageAttachments to handle both new (attachments) and legacy (documents+imageData) formats
      const attachments =
        originalMessage.attachments ?? getMessageAttachments(originalMessage)
      handleQuery(
        newContent,
        attachments.length > 0 ? attachments : undefined,
        undefined,
        truncatedMessages,
      )
    },
    [loadingState, currentChat, handleQuery],
  )

  // Regenerate a message - same as edit but uses the original content
  const regenerateMessage = useCallback(
    (messageIndex: number) => {
      if (loadingState !== 'idle' || !currentChat) return

      const originalMessage = currentChat.messages[messageIndex]
      if (!originalMessage || originalMessage.role !== 'user') return

      // Re-submit with the same content
      editMessage(messageIndex, originalMessage.content || '')
    },
    [loadingState, currentChat, editMessage],
  )

  // Update currentChatIdRef when currentChat changes
  // But don't overwrite during streaming to preserve ID swaps
  useEffect(() => {
    if (!isStreamingRef.current) {
      currentChatIdRef.current = currentChat?.id || ''
    }
  }, [currentChat])

  return {
    input,
    loadingState,
    retryInfo,
    inputRef,
    isThinking,
    isWaitingForResponse,
    isStreaming,
    streamError,
    dismissStreamError,
    setInput,
    handleSubmit,
    handleQuery,
    cancelGeneration,
    editMessage,
    regenerateMessage,
  }
}
