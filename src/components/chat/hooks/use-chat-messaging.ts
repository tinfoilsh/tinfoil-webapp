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
 * - Each `handleQuery` call owns a `streamChatIdRef` tracking the chat it
 *   writes to (handles temporary → server id swaps) independently of other
 *   concurrent streams
 * - `viewedChatIdRef` always mirrors the chat on screen (never frozen during
 *   streaming) so background streams update their list entry without
 *   hijacking the active view
 * - Per-chat stream status lives in `useChatStreams`; the values exposed by
 *   this hook are derived for the currently-viewed chat
 */
import { useProject } from '@/components/project'
import { resolveModelSelection, type BaseModel } from '@/config/models'
import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { generateCodeExecutionAccessToken } from '@/services/exec-snapshot/access-token'
import { getCodeExecutionContainerAuthTokenForChat } from '@/services/exec-snapshot/use-exec-snapshot'
import {
  abandonChatRecoveryAttempt,
  cancelChatRecovery,
  completeLiveChatRecovery,
  persistChatRecoveryToken,
  releaseActiveChatRecovery,
  scanPendingChatRecoveries,
  startChatRecoveryAttempt,
} from '@/services/inference/chat-recovery'
import { sendChatStream } from '@/services/inference/inference-client'
import {
  getRateLimitInfo,
  isChatRecoveryAvailable,
  refreshRateLimit,
} from '@/services/inference/tinfoil-client'
import { generateTitle } from '@/services/inference/title'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMessageAttachments, getMessageImages } from '../attachment-helpers'
import { CONSTANTS } from '../constants'
import type { Chat, LoadingState, Message } from '../types'
import {
  createBlankChat,
  resolveWebSearchEnabled,
  sortChats,
} from './chat-operations'
import { createUpdateChatWithHistoryCheck } from './chat-persistence'
import { processStreamingResponse } from './streaming'
import {
  IDLE_STREAM_STATUS,
  useChatStreams,
  type RetryInfo,
} from './use-chat-streams'
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  scrollToBottom?: () => void
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  webSearchAvailable?: boolean
  codeExecutionEnabled?: boolean
  piiCheckEnabled?: boolean
  genUIEnabled?: boolean
  codeExecutionEncryptionKey?: string | null
}

interface UseChatMessagingReturn {
  input: string
  loadingState: LoadingState
  retryInfo: { attempt: number; maxRetries: number; error?: string } | null
  inputRef: React.RefObject<HTMLTextAreaElement | null>
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
  cancelGeneration: (chatId?: string) => Promise<void>
  editMessage: (messageIndex: number, newContent: string) => void
  regenerateMessage: (messageIndex: number) => void
  retryLastMessage: () => void
  resolveInputToolCall: (
    toolCallId: string,
    resultText: string,
    resultData?: unknown,
  ) => void
}

const CHAT_RECOVERY_POLL_INTERVAL_MS = 10_000

function canUseChatRecovery(options: {
  isSignedIn: boolean | null | undefined
  userId: string | null | undefined
  storeHistory: boolean
  chat?: Pick<Chat, 'isLocalOnly' | 'isTemporary'>
}): boolean {
  const { isSignedIn, userId, storeHistory, chat } = options
  return (
    isSignedIn === true &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    storeHistory &&
    isCloudSyncEnabled() &&
    isChatRecoveryAvailable() &&
    chat?.isLocalOnly !== true &&
    chat?.isTemporary !== true
  )
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
  webSearchAvailable,
  codeExecutionEnabled,
  piiCheckEnabled,
  genUIEnabled,
  codeExecutionEncryptionKey,
}: UseChatMessagingProps): UseChatMessagingReturn {
  const { isSignedIn, userId } = useAuth()
  const { isProjectMode, activeProject } = useProject()

  const [input, setInput] = useState('')

  useEffect(() => {
    if (!isSignedIn || !userId || !storeHistory) return

    const scan = () => {
      if (!canUseChatRecovery({ isSignedIn, userId, storeHistory })) return
      void scanPendingChatRecoveries(userId)
    }
    scan()
    window.addEventListener('online', scan)
    const unsubscribe = chatEvents.on((event) => {
      if (event.reason === 'sync' || event.reason === 'pagination') {
        scan()
      }
    })
    const interval = window.setInterval(scan, CHAT_RECOVERY_POLL_INTERVAL_MS)
    return () => {
      window.removeEventListener('online', scan)
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [isSignedIn, storeHistory, userId])

  // Per-chat stream status so several conversations can stream at once.
  const {
    statusByChat,
    patchStatus,
    resetStatus,
    moveStatus,
    registerController,
    clearController,
    abort,
  } = useChatStreams()

  // Live mirror for reads inside stable callbacks, so streamed status
  // updates don't force handleQuery to be re-created on every chunk.
  const statusByChatRef = useRef(statusByChat)
  statusByChatRef.current = statusByChat

  // Status for the chat on screen drives the input area, stop button,
  // thinking indicator, and error banner.
  const currentStatus =
    statusByChat[currentChat?.id ?? ''] ?? IDLE_STREAM_STATUS
  const {
    loadingState,
    retryInfo,
    isThinking,
    isWaitingForResponse,
    isStreaming,
    streamError,
  } = currentStatus

  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Mirrors the id of the chat on screen. Always current (never frozen
  // during streaming) so background streams write to their own list entry
  // without taking over the active view.
  const viewedChatIdRef = useRef<string>(currentChat?.id || '')
  viewedChatIdRef.current = currentChat?.id || ''

  // Live mirror of the chats state so the persistence helper can re-read
  // per-chat preferences that changed after a stream's snapshot was taken.
  const chatsRef = useRef<Chat[]>(chats)
  chatsRef.current = chats

  const dismissStreamError = useCallback(() => {
    patchStatus(viewedChatIdRef.current, { streamError: null })
  }, [patchStatus])

  // A modified version of updateChat that respects the storeHistory flag.
  // During streaming we persist to IndexedDB but defer cloud backup; the
  // streamed update is mirrored into currentChat only when the streamed
  // chat is the one being viewed.
  const updateChatWithHistoryCheck = useMemo(
    () =>
      createUpdateChatWithHistoryCheck({
        storeHistory,
        viewedChatIdRef,
        chatsRef,
      }),
    [storeHistory],
  )

  // Cancel the stream for a specific chat (defaults to the chat on screen).
  // Passing an explicit id lets callers stop a background stream without
  // first switching to it.
  const cancelGeneration = useCallback(
    async (chatId?: string) => {
      const targetId = chatId ?? viewedChatIdRef.current

      const recoveryCancellation = cancelChatRecovery(targetId)
      abort(targetId)
      patchStatus(targetId, {
        loadingState: 'idle',
        retryInfo: null,
        isThinking: false,
        isWaitingForResponse: false,
        isStreaming: false,
      })

      // If a stream was mid-flight, drop a dangling "thinking" placeholder
      // and persist the truncated transcript for the affected chat.
      if (streamingTracker.isStreaming(targetId)) {
        const stripThinking = (messages: Message[]): Message[] =>
          messages.filter(
            (msg, idx) => !(idx === messages.length - 1 && msg.isThinking),
          )

        setChats((prevChats) => {
          const newChats = prevChats.map((chat) =>
            chat.id === targetId
              ? {
                  ...chat,
                  messages: stripThinking(chat.messages),
                  pendingSave: false,
                }
              : chat,
          )
          const updatedChat = newChats.find((c) => c.id === targetId)
          if (updatedChat && !updatedChat.isTemporary) {
            if (storeHistory) {
              chatStorage
                .saveChatAndSync(updatedChat)
                .then((savedChat) => {
                  // Only update if the ID actually changed
                  if (savedChat.id !== updatedChat.id) {
                    moveStatus(updatedChat.id, savedChat.id)
                    if (viewedChatIdRef.current === updatedChat.id) {
                      viewedChatIdRef.current = savedChat.id
                      setCurrentChat(savedChat)
                    }
                    setChats((prev) =>
                      prev.map((c) =>
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

        // Mirror the truncation into the active view if it's the same chat
        setCurrentChat((prev) =>
          prev.id === targetId
            ? {
                ...prev,
                messages: stripThinking(prev.messages),
                pendingSave: false,
              }
            : prev,
        )

        streamingTracker.endStreaming(targetId)
      }

      await recoveryCancellation

      // Wait for any pending state updates
      await new Promise((resolve) =>
        setTimeout(resolve, CONSTANTS.ASYNC_STATE_DELAY_MS),
      )
    },
    [abort, patchStatus, moveStatus, storeHistory, setChats, setCurrentChat],
  )

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
      // Gate on the target chat's own status so a busy background stream
      // never blocks sending in a different chat.
      const targetChatStatus =
        statusByChatRef.current[currentChat?.id ?? ''] ?? IDLE_STREAM_STATUS

      // Allow empty query if systemPromptOverride, attachments, or a quote are provided
      if (
        (!query.trim() &&
          !systemPromptOverride &&
          !attachments?.length &&
          !quote) ||
        targetChatStatus.loadingState !== 'idle'
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

      // This stream owns its own id tracker, thinking timer, and title
      // promise so it never collides with other in-flight streams. Scoped
      // setters always target the (possibly swapped) id of this stream.
      const streamChatIdRef = { current: currentChat.id }
      const thinkingStartTimeRef: { current: number | null } = {
        current: null,
      }
      let earlyTitlePromise: Promise<string> | null = null

      const setLoadingStateFor = (s: LoadingState) =>
        patchStatus(streamChatIdRef.current, { loadingState: s })
      const setRetryInfoFor = (r: RetryInfo | null) =>
        patchStatus(streamChatIdRef.current, { retryInfo: r })
      const setIsThinkingFor = (v: boolean) =>
        patchStatus(streamChatIdRef.current, { isThinking: v })
      const setIsWaitingForResponseFor = (v: boolean) =>
        patchStatus(streamChatIdRef.current, { isWaitingForResponse: v })
      const setIsStreamingFor = (v: boolean) =>
        patchStatus(streamChatIdRef.current, { isStreaming: v })
      const setStreamErrorFor = (e: string | null) =>
        patchStatus(streamChatIdRef.current, { streamError: e })

      const controller = new AbortController()
      registerController(streamChatIdRef.current, controller)
      resetStatus(streamChatIdRef.current, {
        loadingState: 'loading',
        isWaitingForResponse: true,
        isStreaming: true,
      })

      // Only create a user message if there's actual query content
      // When using system prompt override with empty query, skip user message
      const hasUserContent =
        query.trim() !== '' ||
        (attachments && attachments.length > 0) ||
        Boolean(quote)
      const turnId = hasUserContent ? crypto.randomUUID() : null

      const userMessage: Message | null = hasUserContent
        ? {
            role: 'user',
            content: query,
            turnId: turnId as string,
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
        earlyTitlePromise = null
      }

      // Handle blank chat conversion: create chat immediately with server-valid ID
      if (isBlankChat && currentChat.isTemporary) {
        updatedMessages = userMessage ? [userMessage] : []
        updatedChat = {
          ...currentChat,
          title: 'Temporary Chat',
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
        }

        moveStatus(streamChatIdRef.current, updatedChat.id)
        streamChatIdRef.current = updatedChat.id
        setCurrentChat(updatedChat)
        setChats((prevChats) =>
          prevChats.map((c) => (c.id === updatedChat.id ? updatedChat : c)),
        )

        if (scrollToBottom) {
          setTimeout(() => scrollToBottom(), 50)
        }
      } else if (isBlankChat && storeHistory) {
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
          codeExecutionAccessToken: generateCodeExecutionAccessToken(),
          title: 'Untitled',
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
          isLocalOnly: currentChat.isLocalOnly || !isCloudSyncEnabled(),
          pendingSave: true,
          model: selectedModel,
          projectId:
            isProjectMode && activeProject ? activeProject.id : undefined,
        }

        // Update state immediately for instant UI feedback
        moveStatus(streamChatIdRef.current, chatId)
        streamChatIdRef.current = chatId
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
          model: selectedModel,
        }

        moveStatus(streamChatIdRef.current, updatedChat.id)
        streamChatIdRef.current = updatedChat.id
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

        if (!updatedChat.isTemporary) {
          sessionChatStorage.saveChat(updatedChat)
        }

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
          model: selectedModel,
          // Backfill for chats created before this field existed.
          codeExecutionAccessToken:
            updatedChat.codeExecutionAccessToken ??
            generateCodeExecutionAccessToken(),
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
        if (updatedChat.isTemporary) {
          // Temporary chats are never persisted
        } else if (storeHistory) {
          await chatStorage.saveChatAndSync(updatedChat)
        } else {
          sessionChatStorage.saveChat(updatedChat)
        }
      }

      // Capture the starting chat ID before any async operations that might change it
      const startingChatId = streamChatIdRef.current

      // Fire title generation in parallel with streaming (based on user's message).
      // The promise is awaited after streaming completes, before the final save.
      if (isFirstMessage && userMessage) {
        // When the user pastes long text it is captured as a document
        // attachment rather than message text, leaving content empty. Fall
        // back to attachment text/description so these chats still get a title.
        const titleContent =
          userMessage.content?.trim() ||
          (userMessage.attachments
            ?.map((a) => a.textContent || a.description || a.fileName)
            .filter(Boolean)
            .join('\n') ??
            '')
        const titlePromise = generateTitle([
          { role: 'user', content: titleContent },
        ])
        // Prevent unhandled rejection if streaming exits early and the
        // promise is never awaited (e.g. abort, navigation, empty response)
        titlePromise.catch(() => {})
        earlyTitlePromise = titlePromise
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
        // Auto selections prefer a multimodal candidate when the turn carries
        // images, and a tool-calling candidate when web search, code execution,
        // or the default-enabled GenUI tools are active, so the router favors a
        // model that can service the request when one is available.
        const preferMultimodal = updatedMessages.some(
          (m) => getMessageImages(m).length > 0,
        )
        const chatWebSearchEnabled = resolveWebSearchEnabled(
          webSearchAvailable ?? true,
          updatedChat.webSearchEnabled,
        )
        const preferToolCalling = Boolean(
          chatWebSearchEnabled ||
          codeExecutionEnabled ||
          (genUIEnabled ?? true),
        )
        const { model, autoCandidates } = resolveModelSelection(
          selectedModel,
          models,
          { preferMultimodal, preferToolCalling },
        )
        if (!model) {
          throw new Error(`Model ${selectedModel} not found`)
        }

        logInfo('[handleQuery] Starting streaming with model', {
          component: 'useChatMessaging',
          action: 'handleQuery.startStreaming',
          metadata: {
            model: selectedModel,
            chatId: streamChatIdRef.current,
            startingChatId,
            isLocalOnly: updatedChat.isLocalOnly,
            messageCount: updatedMessages.length,
          },
        })

        const baseSystemPrompt = systemPromptOverride || systemPrompt

        const codeExecutionContainerAuthToken = codeExecutionEnabled
          ? ((await getCodeExecutionContainerAuthTokenForChat(
              updatedChat.id,
            )) ?? undefined)
          : undefined

        const recoveryUserId = typeof userId === 'string' ? userId : null
        const recoveryEligible =
          recoveryUserId !== null &&
          turnId !== null &&
          canUseChatRecovery({
            isSignedIn,
            userId: recoveryUserId,
            storeHistory,
            chat: updatedChat,
          })
        // Recovery is best-effort: if the user turn cannot be committed to
        // the cloud right now, stream normally instead of failing the send.
        let recoveryEnabled = recoveryEligible

        if (recoveryEnabled) {
          try {
            updatedChat = await chatStorage.saveChatAndWaitForSync(updatedChat)
          } catch (error) {
            recoveryEnabled = false
            logError(
              'Chat upload for recovery failed; streaming without recovery',
              error,
              {
                component: 'useChatMessaging',
                action: 'handleQuery.recoveryPreUpload',
                metadata: { chatId: updatedChat.id },
              },
            )
          }
        }

        // Mark the chat as streaming up front (after the initial creation
        // save above) so the sidebar indicator and cloud-sync gating cover
        // the whole request, including the wait for the first token. The
        // stream processor's own startStreaming call is idempotent.
        streamingTracker.startStreaming(streamChatIdRef.current)

        const response = await sendChatStream({
          model,
          autoCandidates,
          systemPrompt: baseSystemPrompt,
          rules,
          onRetry: (attempt, maxRetries, error) => {
            setLoadingStateFor('retrying')
            setRetryInfoFor({ attempt, maxRetries, error })
          },
          updatedMessages,
          signal: controller.signal,
          reasoningEffort,
          thinkingEnabled,
          webSearchEnabled: chatWebSearchEnabled,
          codeExecutionEnabled,
          piiCheckEnabled,
          genUIEnabled: genUIEnabled ?? true,
          codeExecutionAccessToken: updatedChat.codeExecutionAccessToken,
          codeExecutionEncryptionKey: codeExecutionEncryptionKey ?? undefined,
          codeExecutionContainerAuthToken,
          recovery:
            recoveryEligible && recoveryEnabled
              ? {
                  onAttemptStarted: (sessionId) => {
                    startChatRecoveryAttempt(
                      streamChatIdRef.current,
                      turnId,
                      sessionId,
                    )
                  },
                  onTokenCaptured: (sessionId, token) =>
                    persistChatRecoveryToken({
                      userId: recoveryUserId as string,
                      chatId: streamChatIdRef.current,
                      turnId,
                      sessionId,
                      token,
                    }),
                  onAttemptAbandoned: abandonChatRecoveryAttempt,
                }
              : undefined,
        })

        const assistantMessage = await processStreamingResponse(response, {
          updatedChat,
          updatedMessages,
          isFirstMessage,
          modelsLength: models.length,
          streamChatIdRef,
          thinkingStartTimeRef,
          setIsThinking: setIsThinkingFor,
          setIsWaitingForResponse: setIsWaitingForResponseFor,
          setIsStreaming: setIsStreamingFor,
          updateChatWithHistoryCheck,
          setChats,
          setCurrentChat,
          setLoadingState: setLoadingStateFor,
          storeHistory,
          startingChatId,
        })
        if (assistantMessage && turnId) {
          assistantMessage.turnId = turnId
        }

        const hasAssistantMessageToSave =
          !!assistantMessage &&
          (!!assistantMessage.content ||
            !!assistantMessage.thoughts ||
            !!assistantMessage.webSearch ||
            !!assistantMessage.urlFetches?.length ||
            !!assistantMessage.toolCalls?.length ||
            !!assistantMessage.codeExecCalls?.length ||
            !!assistantMessage.timeline?.length)

        if (assistantMessage && hasAssistantMessageToSave) {
          // Use this stream's own id (already reflects any server id swap).
          // The response is always saved to that chat, even if the user has
          // navigated to a different conversation while it streamed.
          const chatId = streamChatIdRef.current

          logInfo('[handleQuery] Streaming completed, processing response', {
            component: 'useChatMessaging',
            action: 'handleQuery.streamingComplete',
            metadata: {
              chatId,
              isLocalOnly: updatedChat.isLocalOnly,
              hasContent: !!assistantMessage.content,
              hasThoughts: !!assistantMessage.thoughts,
              hasToolCalls: !!assistantMessage.toolCalls?.length,
              hasTimeline: !!assistantMessage.timeline?.length,
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
            earlyTitlePromise
          ) {
            try {
              const generated = await earlyTitlePromise
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
            model: selectedModel,
            // Keep the pending flag set through the real upload. The
            // sidebar badge is suppressed while streaming, so it now
            // surfaces only here - once the stream stops and the chat
            // is actually syncing - and clears when the save resolves.
            // Temporary chats skip persistence entirely, so the flag
            // would never clear for them.
            pendingSave: !updatedChat.isTemporary,
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

          if (recoveryEnabled && turnId) {
            try {
              await completeLiveChatRecovery({
                chatId,
                turnId,
                assistantMessage,
                chatPatch: {
                  title: resolvedTitle,
                  titleState: resolvedTitleState,
                  model: selectedModel,
                  projectId: updatedChat.projectId,
                },
              })
            } catch (error) {
              releaseActiveChatRecovery(chatId)
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                throw error
              }
              logError('Failed to finalize recoverable chat response', error, {
                component: 'useChatMessaging',
                action: 'handleQuery.recoveryComplete',
                metadata: { chatId },
              })
              updateChatWithHistoryCheck(
                setChats,
                chatToSave,
                setCurrentChat,
                chatId,
                finalMessages,
                false,
              )
            }
          } else {
            updateChatWithHistoryCheck(
              setChats,
              chatToSave,
              setCurrentChat,
              chatId,
              finalMessages,
              false,
            )
          }
        } else {
          if (recoveryEnabled) {
            await cancelChatRecovery(streamChatIdRef.current)
          }
          logWarning('No assistant content to save after streaming', {
            component: 'useChatMessaging',
            action: 'handleQuery',
          })
        }
      } catch (error) {
        releaseActiveChatRecovery(streamChatIdRef.current)
        if (
          typeof userId === 'string' &&
          canUseChatRecovery({ isSignedIn, userId, storeHistory })
        ) {
          void scanPendingChatRecoveries(userId)
        }
        // Ensure UI loading flags are reset on pre-stream errors
        setIsWaitingForResponseFor(false)
        setIsStreamingFor(false)
        setLoadingStateFor('idle')
        setIsThinkingFor(false)
        thinkingStartTimeRef.current = null
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          logError('Chat query failed', error, {
            component: 'useChatMessaging',
            action: 'handleQuery',
          })

          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error occurred'
          const lowerMsg = errorMsg.toLowerCase()
          const isHourlyRateLimitError =
            lowerMsg.includes('hourly usage limit') ||
            lowerMsg.includes('hourly limit')
          const isRateLimitError =
            lowerMsg.includes('rate limit') ||
            lowerMsg.includes('request limit') ||
            lowerMsg.includes('usage limit') ||
            lowerMsg.includes('insufficient_quota')

          if (isRateLimitError) {
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${errorMsg}`,
              timestamp: new Date(),
              isError: true,
              isRateLimitError: !isHourlyRateLimitError,
              isHourlyRateLimitError,
            }

            // Use this stream's id which has the correct (possibly server) ID
            const currentId = streamChatIdRef.current || updatedChat.id
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
            setStreamErrorFor(errorMsg)
          }
        }
      } finally {
        // Refresh rate limit from server for free-tier users so the
        // banner/send-blocking reflects the server's actual count
        // (covers both success and error paths, e.g. 429 responses).
        if (getRateLimitInfo() !== null) {
          refreshRateLimit()
        }

        // Settle this stream's status (preserving any streamError so the
        // banner can surface when the user returns to the chat).
        patchStatus(streamChatIdRef.current, {
          loadingState: 'idle',
          retryInfo: null,
          isWaitingForResponse: false,
          isStreaming: false,
          isThinking: false,
        })
        clearController(streamChatIdRef.current)
        // Covers pre-stream failures where the processor (which normally
        // ends streaming) never ran. Idempotent if already ended.
        streamingTracker.endStreaming(streamChatIdRef.current)
      }
    },
    [
      currentChat,
      isSignedIn,
      userId,
      storeHistory,
      setChats,
      setCurrentChat,
      models,
      selectedModel,
      systemPrompt,
      rules,
      updateChatWithHistoryCheck,
      scrollToBottom,
      reasoningEffort,
      thinkingEnabled,
      isProjectMode,
      activeProject,
      webSearchAvailable,
      codeExecutionEnabled,
      piiCheckEnabled,
      genUIEnabled,
      codeExecutionEncryptionKey,
      patchStatus,
      resetStatus,
      moveStatus,
      registerController,
      clearController,
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

  /**
   * Resolve a pending input-surface GenUI tool call.
   *
   * Marks the matching `tool_call` block as resolved on the last assistant
   * message and sends the user's choice as a follow-up user message. The new
   * message runs through `handleQuery` so the assistant continues the
   * conversation naturally.
   */
  const resolveInputToolCall = useCallback(
    (toolCallId: string, resultText: string, resultData?: unknown) => {
      if (loadingState !== 'idle' || !currentChat) return

      const now = Date.now()
      const applyToMessages = (messages: Message[]): Message[] => {
        if (messages.length === 0) return messages
        const updated = [...messages]
        for (let i = updated.length - 1; i >= 0; i--) {
          const msg = updated[i]
          if (msg.role !== 'assistant' || !msg.timeline) continue
          const newTimeline = msg.timeline.map((block) => {
            if (
              block.type === 'tool_call' &&
              block.toolCallId === toolCallId &&
              !block.resolvedAt
            ) {
              return {
                ...block,
                resolvedAt: now,
                resolution: {
                  text: resultText,
                  data: resultData,
                  resolvedAt: now,
                },
              }
            }
            return block
          })
          updated[i] = { ...msg, timeline: newTimeline }
          break
        }
        return updated
      }

      const resolvedMessages = applyToMessages(currentChat.messages)

      setChats((prevChats) =>
        prevChats.map((c) =>
          c.id === currentChat.id ? { ...c, messages: resolvedMessages } : c,
        ),
      )
      setCurrentChat((prev) =>
        prev ? { ...prev, messages: resolvedMessages } : prev,
      )

      // Pass `resolvedMessages` as the baseline so `handleQuery` doesn't
      // overwrite the just-written resolution with stale closure state. If
      // we didn't, the pending input-surface widget would linger for one
      // render cycle while the input area waits for the streaming phase to
      // push past it — visible as a brief delay before the widget
      // disappears after the user clicks an option.
      handleQuery(resultText, undefined, undefined, resolvedMessages)
    },
    [loadingState, currentChat, setChats, setCurrentChat, handleQuery],
  )

  // Tracks a regenerate request issued while a stream is in flight. Once
  // the in-progress generation has been cancelled and `loadingState`
  // settles back to 'idle', the deferred request is fired by the effect
  // below. The chat id is captured alongside the index so a chat switch
  // during cancellation cannot redirect the regenerate to a different
  // conversation.
  const pendingRegenerateRef = useRef<{
    chatId: string
    messageIndex: number
  } | null>(null)

  // Regenerate a message - same as edit but uses the original content.
  // If a stream is currently in flight, cancel it first and defer the
  // regeneration until state settles.
  const regenerateMessage = useCallback(
    (messageIndex: number) => {
      if (!currentChat) return
      if (pendingRegenerateRef.current !== null) return

      const originalMessage = currentChat.messages[messageIndex]
      if (!originalMessage || originalMessage.role !== 'user') return

      const isGenerationActive =
        loadingState !== 'idle' ||
        isStreaming ||
        isWaitingForResponse ||
        isThinking ||
        streamingTracker.isStreaming(currentChat.id)

      if (isGenerationActive) {
        pendingRegenerateRef.current = {
          chatId: currentChat.id,
          messageIndex,
        }
        void cancelGeneration()
        return
      }

      editMessage(messageIndex, originalMessage.content || '')
    },
    [
      loadingState,
      isStreaming,
      isWaitingForResponse,
      isThinking,
      currentChat,
      editMessage,
      cancelGeneration,
    ],
  )

  // Fire the deferred regenerate once cancellation has settled the state.
  useEffect(() => {
    if (
      loadingState !== 'idle' ||
      isStreaming ||
      isWaitingForResponse ||
      isThinking
    )
      return
    const pending = pendingRegenerateRef.current
    if (pending === null || !currentChat) return

    // Drop the deferred request if the user navigated to a different
    // chat while cancellation was in flight — regenerating against an
    // unrelated conversation would silently rewrite its history.
    if (currentChat.id !== pending.chatId) {
      pendingRegenerateRef.current = null
      return
    }

    const originalMessage = currentChat.messages[pending.messageIndex]
    if (!originalMessage || originalMessage.role !== 'user') {
      pendingRegenerateRef.current = null
      return
    }

    pendingRegenerateRef.current = null
    editMessage(pending.messageIndex, originalMessage.content || '')
  }, [
    loadingState,
    isStreaming,
    isWaitingForResponse,
    isThinking,
    currentChat,
    editMessage,
  ])

  // Re-send the most recent user message, e.g. after a failed stream.
  // Calls handleQuery directly instead of going through regenerateMessage
  // → editMessage, whose closure-based guards (pendingRegenerateRef,
  // loadingState) can be stale after a stream error and silently no-op.
  const retryLastMessage = useCallback(() => {
    if (!currentChat) return
    for (let i = currentChat.messages.length - 1; i >= 0; i--) {
      if (currentChat.messages[i].role === 'user') {
        const originalMessage = currentChat.messages[i]
        patchStatus(currentChat.id, { streamError: null })
        const truncatedMessages = currentChat.messages.slice(0, i)
        const attachments = getMessageAttachments(originalMessage)
        handleQuery(
          originalMessage.content || '',
          attachments.length > 0 ? attachments : undefined,
          undefined,
          truncatedMessages,
          originalMessage.quote,
        )
        return
      }
    }
  }, [currentChat, patchStatus, handleQuery])

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
    retryLastMessage,
    resolveInputToolCall,
  }
}
