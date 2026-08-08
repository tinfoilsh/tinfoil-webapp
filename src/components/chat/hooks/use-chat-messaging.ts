/**
 * Chat messaging hook
 *
 * Responsibilities:
 * - Orchestrates user input → persistence, network streaming, and UI state
 * - Delegates heavy-lift to:
 *   - persistence: hooks/chat-persistence.ts (local/IndexedDB + cloud sync gating)
 *   - network: services/inference (request construction + typed chunk streams)
 *   - streaming: hooks/streaming (normalization, assembly, and publication)
 *
 * State invariants:
 * - Each `handleQuery` call owns a `streamChatIdRef` tracking the chat it
 *   writes to as blank chats receive their permanent identity, independently
 *   of other concurrent streams
 * - `viewedChatIdRef` always mirrors the chat on screen so status actions
 *   target the active conversation while background streams continue
 * - Per-chat stream status lives in `useChatStreams`; the values exposed by
 *   this hook are derived for the currently-viewed chat
 */
import { useProject } from '@/components/project'
import { resolveModelSelection, type BaseModel } from '@/config/models'
import { DEFAULT_CHAT_TITLE, TEMPORARY_CHAT_TITLE } from '@/constants/chat'
import { useChatRecoveryActive } from '@/hooks/use-chat-recovery-drafts'
import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { generateCodeExecutionAccessToken } from '@/services/exec-snapshot/access-token'
import { getCodeExecutionContainerAuthTokenForChat } from '@/services/exec-snapshot/use-exec-snapshot'
import {
  abandonChatRecoveryAttempt,
  cancelChatRecovery,
  completeLiveChatRecovery,
  markChatRecoveryTurnCancelled,
  persistChatRecoveryToken,
  releaseActiveChatRecovery,
  scanPendingChatRecoveries,
  startChatRecoveryAttempt,
} from '@/services/inference/chat-recovery'
import {
  clearActiveChatRecoveriesForChat,
  setChatRecoveryActive,
} from '@/services/inference/chat-recovery-drafts'
import { persistInterruptedAssistant } from '@/services/inference/chat-recovery-sync'
import type { ChatChunkStream } from '@/services/inference/chat-stream'
import { sendChatStream } from '@/services/inference/inference-client'
import {
  getRateLimitInfo,
  isChatRecoveryAvailable,
  refreshRateLimit,
} from '@/services/inference/tinfoil-client'
import { generateTitle, getTitleContent } from '@/services/inference/title'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMessageAttachments, getMessageImages } from '../attachment-helpers'
import { ChatError } from '../chat-utils'
import { CONSTANTS } from '../constants'
import { regenerateToolCallArguments } from '../genui/retry'
import type { Chat, LoadingState, Message } from '../types'
import {
  createBlankChat,
  resolveWebSearchEnabled,
  sortChats,
} from './chat-operations'
import { createUpdateChatWithHistoryCheck } from './chat-persistence'
import {
  hasVisibleAssistantMessage,
  mergeInterruptedAssistant,
  processStreamingResponse,
} from './streaming'
import {
  IDLE_STREAM_STATUS,
  useChatStreams,
  type RetryInfo,
  type StreamErrorInfo,
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
  streamError: StreamErrorInfo | null
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
  retryToolCall: (messageIndex: number, toolCallId: string) => Promise<boolean>
}

type ActiveLiveGeneration = {
  chat: Chat
  messages: Message[]
  turnId?: string
  latestAssistantMessage: Message | null
  initialSave?: Promise<void>
}

const CHAT_RECOVERY_POLL_INTERVAL_MS = 10_000

function canUseChatRecovery(options: {
  isSignedIn: boolean | null | undefined
  userId: string | null | undefined
  storeHistory: boolean
  chat?: Pick<Chat, 'isTemporary'>
}): boolean {
  const { isSignedIn, userId, storeHistory, chat } = options
  return (
    isSignedIn === true &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    storeHistory &&
    isChatRecoveryAvailable() &&
    chat?.isTemporary !== true
  )
}

async function waitForRecoveryReady(
  stream: ChatChunkStream,
  signal: AbortSignal,
): Promise<void> {
  if (!stream.recoveryReady) return
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    stream.recoveryReady?.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
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
  const currentChatId = currentChat?.id ?? ''
  const currentChatIsTemporary = currentChat?.isTemporary
  const recoveryScanKey =
    currentChat?.pendingRecoveries
      ?.map((envelope) => envelope.turnId)
      .join('\u0000') ?? ''

  useEffect(() => {
    if (!isSignedIn || !userId || !storeHistory) return

    const scan = (refreshPending = false) => {
      if (!canUseChatRecovery({ isSignedIn, userId, storeHistory })) return
      void scanPendingChatRecoveries(userId, refreshPending)
    }
    scan()
    const scanCurrent = () => scan()
    const refreshScan = () => scan(true)
    window.addEventListener('online', scanCurrent)
    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, refreshScan)
    const unsubscribe = chatEvents.on((event) => {
      if (event.reason === 'sync' || event.reason === 'pagination') {
        scanCurrent()
      }
    })
    const interval = window.setInterval(
      scanCurrent,
      CHAT_RECOVERY_POLL_INTERVAL_MS,
    )
    return () => {
      window.removeEventListener('online', scanCurrent)
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, refreshScan)
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [isSignedIn, storeHistory, userId])

  useEffect(() => {
    if (
      !recoveryScanKey ||
      !userId ||
      !canUseChatRecovery({
        isSignedIn,
        userId,
        storeHistory,
        chat: currentChatIsTemporary
          ? { isTemporary: currentChatIsTemporary }
          : undefined,
      })
    ) {
      return
    }
    void scanPendingChatRecoveries(userId, true)
  }, [
    currentChatId,
    currentChatIsTemporary,
    isSignedIn,
    recoveryScanKey,
    storeHistory,
    userId,
  ])

  // Per-chat stream status so several conversations can stream at once.
  const {
    statusByChat,
    patchStatus,
    resetStatus,
    moveStatus,
    registerController,
    clearController,
    ownsController,
    hasActiveController,
    abort,
  } = useChatStreams()

  // Live mirror for reads inside stable callbacks, so streamed status
  // updates don't force handleQuery to be re-created on every chunk.
  const statusByChatRef = useRef(statusByChat)
  statusByChatRef.current = statusByChat

  // Status for the chat on screen drives the input area, stop button,
  // thinking indicator, and error banner.
  const currentStatus = statusByChat[currentChatId] ?? IDLE_STREAM_STATUS
  const {
    loadingState: streamLoadingState,
    retryInfo,
    isThinking,
    isWaitingForResponse,
    isStreaming: isLiveStreaming,
    streamError,
  } = currentStatus
  const isRecoveryActive = useChatRecoveryActive(currentChatId)
  const isStreaming = isLiveStreaming || isRecoveryActive
  const loadingState =
    isStreaming && streamLoadingState !== 'retrying'
      ? 'loading'
      : streamLoadingState

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
  const currentChatRef = useRef(currentChat)
  currentChatRef.current = currentChat
  const findLiveChat = useCallback(
    (chatId: string) =>
      (currentChatRef.current.id === chatId
        ? currentChatRef.current
        : undefined) ?? chatsRef.current.find((chat) => chat.id === chatId),
    [],
  )

  const activeLiveGenerationsRef = useRef(
    new Map<string, ActiveLiveGeneration>(),
  )
  const cancellationPromisesRef = useRef(new Map<string, Promise<void>>())

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
        chatsRef,
        currentChatRef,
      }),
    [storeHistory],
  )

  // Cancel the stream for a specific chat (defaults to the chat on screen).
  // Passing an explicit id lets callers stop a background stream without
  // first switching to it.
  const cancelGeneration = useCallback(
    (chatId?: string) => {
      const targetId = chatId ?? viewedChatIdRef.current
      // Dedupe repeated stop presses for the same stream, but not when a
      // newer stream has registered a controller since: its abort must not
      // be swallowed by a previous cancellation still finishing its tail.
      const existingCancellation = cancellationPromisesRef.current.get(targetId)
      if (existingCancellation && !hasActiveController(targetId)) {
        return existingCancellation
      }

      const cancellation = (async () => {
        const activeGeneration = activeLiveGenerationsRef.current.get(targetId)

        abort(targetId)
        // Mark the recovery turn cancelled synchronously with the abort.
        // When stop lands before the first token, the recovery attempt may
        // still be registering (token capture races the abort); the mark
        // makes persistChatRecoveryToken discard its envelope instead of
        // surfacing "Recovering stream..." for a turn the user just stopped.
        if (activeGeneration?.turnId) {
          markChatRecoveryTurnCancelled(targetId, activeGeneration.turnId)
          setChatRecoveryActive(targetId, activeGeneration.turnId, false)
        } else {
          clearActiveChatRecoveriesForChat(targetId)
        }
        const interruptedMessage =
          activeGeneration?.latestAssistantMessage &&
          hasVisibleAssistantMessage(activeGeneration.latestAssistantMessage)
            ? activeGeneration.latestAssistantMessage
            : null
        patchStatus(targetId, {
          loadingState: 'idle',
          retryInfo: null,
          isThinking: false,
          isWaitingForResponse: false,
          isStreaming: false,
        })

        let stoppedChat: Chat | undefined
        let finalizeStoppedChat: ((chat: Chat) => Chat) | undefined
        if (activeGeneration) {
          const finalizeChat = (chat: Chat): Chat => {
            const hasOriginatingUser = activeGeneration.turnId
              ? chat.messages.some(
                  (message) =>
                    message.role === 'user' &&
                    message.turnId === activeGeneration.turnId,
                )
              : false
            const sourceMessages = hasOriginatingUser
              ? chat.messages
              : activeGeneration.messages
            const messages = activeGeneration.turnId
              ? mergeInterruptedAssistant(
                  sourceMessages,
                  activeGeneration.turnId,
                  interruptedMessage,
                )
              : interruptedMessage
                ? [...activeGeneration.messages, interruptedMessage]
                : activeGeneration.messages
            return {
              ...chat,
              messages,
              pendingRecoveries: chat.pendingRecoveries?.filter(
                (recovery) => recovery.turnId !== activeGeneration.turnId,
              ),
              pendingSave: false,
            }
          }
          finalizeStoppedChat = finalizeChat
          const latestChat = findLiveChat(targetId) ?? activeGeneration.chat
          const finalizedChat = finalizeChat(latestChat)
          stoppedChat = finalizedChat
          setChats((prevChats) =>
            prevChats.map((chat) =>
              chat.id === targetId ? finalizeChat(chat) : chat,
            ),
          )
          setCurrentChat((prev) =>
            prev.id === targetId ? finalizeChat(prev) : prev,
          )
        }

        await activeGeneration?.initialSave

        let recoveryHandled = false
        try {
          recoveryHandled = await cancelChatRecovery(
            targetId,
            interruptedMessage ?? undefined,
            activeGeneration?.turnId,
          )
        } catch (error) {
          recoveryHandled = true
          logError('Failed to cancel chat recovery', error, {
            component: 'useChatMessaging',
            action: 'cancelGeneration.recovery',
            metadata: { chatId: targetId },
          })
        }

        if (
          interruptedMessage &&
          stoppedChat &&
          !stoppedChat.isTemporary &&
          !recoveryHandled
        ) {
          try {
            if (storeHistory && activeGeneration?.turnId) {
              await persistInterruptedAssistant(
                targetId,
                activeGeneration.turnId,
                interruptedMessage,
              )
            } else if (storeHistory) {
              await chatStorage.saveChatAndSync(stoppedChat)
            } else {
              const latestChat =
                sessionChatStorage
                  .getAllChats()
                  .find((chat) => chat.id === targetId) ??
                findLiveChat(targetId) ??
                stoppedChat
              const chatToSave =
                finalizeStoppedChat?.(latestChat) ?? stoppedChat
              sessionChatStorage.saveChat(chatToSave)
            }
          } catch (error) {
            logError('Failed to save chat after cancellation', error, {
              component: 'useChatMessaging',
              action: 'cancelGeneration.save',
              metadata: { chatId: targetId },
            })
          }
        }

        // A new stream may have started on this chat while the async saves
        // above were in flight (e.g. the user quickly resumed). Its
        // controller registration marks ownership; in that case leave the
        // streaming marker and status alone so the tail of this cancel
        // can't idle the successor mid-stream.
        if (!hasActiveController(targetId)) {
          streamingTracker.endStreaming(targetId)
          patchStatus(targetId, { loadingState: 'idle' })
        }
      })()

      cancellationPromisesRef.current.set(targetId, cancellation)
      const clearCancellation = () => {
        if (cancellationPromisesRef.current.get(targetId) === cancellation) {
          cancellationPromisesRef.current.delete(targetId)
        }
      }
      void cancellation.then(clearCancellation, clearCancellation)
      return cancellation
    },
    [
      abort,
      findLiveChat,
      hasActiveController,
      patchStatus,
      storeHistory,
      setChats,
      setCurrentChat,
    ],
  )

  // Handle chat query
  // Lifecycle overview:
  // 1) Early exits + input reset
  // 2) Optimistic state update with the user message (and identity assignment if needed)
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
        targetChatStatus.loadingState !== 'idle' ||
        isRecoveryActive
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

      // This stream owns its own id tracker and title promise so it never
      // collides with other in-flight streams. Scoped setters always target
      // the (possibly swapped) id of this stream.
      const streamChatIdRef = { current: currentChat.id }
      let earlyTitlePromise: Promise<string> | null = null
      let initialSavePromise: Promise<void> | undefined

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
      const setStreamErrorFor = (e: StreamErrorInfo | null) =>
        patchStatus(streamChatIdRef.current, { streamError: e })

      const controller = new AbortController()
      registerController(streamChatIdRef.current, controller)
      resetStatus(streamChatIdRef.current, {
        loadingState: 'loading',
        isWaitingForResponse: true,
        isStreaming: true,
      })

      // Mark the pre-stream phase (saves, token fetches) so storage reloads
      // don't adopt a stale stored copy of this chat before the stream's
      // first flush. Follows the stream's id across blank-chat conversions.
      let pendingStreamId: string | null = null
      const markPendingStream = (id: string) => {
        if (pendingStreamId === id) return
        if (pendingStreamId !== null) {
          streamingTracker.endPendingStream(pendingStreamId)
        }
        pendingStreamId = id
        streamingTracker.beginPendingStream(id)
      }
      markPendingStream(streamChatIdRef.current)

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
          title: TEMPORARY_CHAT_TITLE,
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
          codeExecutionAccessToken:
            currentChat.codeExecutionAccessToken ??
            generateCodeExecutionAccessToken(),
        }

        moveStatus(streamChatIdRef.current, updatedChat.id)
        streamChatIdRef.current = updatedChat.id
        markPendingStream(updatedChat.id)
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
          title: DEFAULT_CHAT_TITLE,
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
        markPendingStream(chatId)
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
        initialSavePromise = chatStorage
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
          title: DEFAULT_CHAT_TITLE,
          titleState: 'placeholder',
          messages: updatedMessages,
          isBlankChat: false,
          createdAt: new Date(),
          pendingSave: true,
          model: selectedModel,
        }

        moveStatus(streamChatIdRef.current, updatedChat.id)
        streamChatIdRef.current = updatedChat.id
        markPendingStream(updatedChat.id)
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

      if (controller.signal.aborted) {
        if (pendingStreamId !== null) {
          streamingTracker.endPendingStream(pendingStreamId)
        }
        clearController(streamChatIdRef.current, controller)
        return
      }

      // Capture the starting chat ID before any async operations that might change it
      const startingChatId = streamChatIdRef.current
      const activeGeneration: ActiveLiveGeneration = {
        chat: updatedChat,
        messages: updatedMessages,
        turnId: turnId ?? undefined,
        latestAssistantMessage: null,
        initialSave: initialSavePromise,
      }
      activeLiveGenerationsRef.current.set(startingChatId, activeGeneration)

      // Fire title generation in parallel with streaming (based on user's message).
      // The promise is awaited after streaming completes, before the final save.
      if (isFirstMessage && userMessage) {
        // When the user pastes long text it is captured as a document
        // attachment rather than message text, leaving content empty. Fall
        // back to attachment text/description so these chats still get a title.
        const titleContent = getTitleContent(userMessage)
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

      let response: ChatChunkStream | null = null
      const recoveryCleanupByChat = new Map<string, Promise<void>>()
      const abandonAndReleaseRecovery = (chatId: string): Promise<void> => {
        const existingCleanup = recoveryCleanupByChat.get(chatId)
        if (existingCleanup) return existingCleanup

        const cleanup = (async () => {
          try {
            await response?.abandonRecovery?.()
          } catch (cleanupError) {
            logError(
              'Failed to abandon recoverable chat response',
              cleanupError,
              {
                component: 'useChatMessaging',
                action: 'handleQuery.recoveryAbandon',
                metadata: { chatId },
              },
            )
          } finally {
            releaseActiveChatRecovery(chatId)
          }
        })()
        recoveryCleanupByChat.set(chatId, cleanup)
        return cleanup
      }
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
        // Recovery is best-effort: the user turn must be durable before the
        // recovery token is captured, locally or across devices.
        let recoveryEnabled = recoveryEligible

        if (recoveryEnabled) {
          try {
            updatedChat =
              updatedChat.isLocalOnly || !isCloudSyncEnabled()
                ? await chatStorage.saveChat(updatedChat, true)
                : await chatStorage.saveChatAndWaitForSync(updatedChat)
          } catch (error) {
            recoveryEnabled = false
            logError(
              'Chat persistence for recovery failed; streaming without recovery',
              error,
              {
                component: 'useChatMessaging',
                action: 'handleQuery.recoveryPreUpload',
                metadata: { chatId: updatedChat.id },
              },
            )
          }
        }

        if (controller.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        // Mark the chat as streaming up front (after the initial creation
        // save above) so the sidebar indicator and cloud-sync gating cover
        // the whole request, including the wait for the first token. The
        // stream processor's own startStreaming call is idempotent.
        streamingTracker.startStreaming(streamChatIdRef.current)

        response = await sendChatStream({
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
          streamChatIdRef,
          onUpdate: (message) => {
            const chatId = streamChatIdRef.current
            updateChatWithHistoryCheck(
              setChats,
              { ...updatedChat, id: chatId },
              setCurrentChat,
              chatId,
              [...updatedMessages, message],
              { skipIndexedDBSave: true },
            )
          },
          setIsThinking: setIsThinkingFor,
          setIsWaitingForResponse: setIsWaitingForResponseFor,
          setIsStreaming: setIsStreamingFor,
          setLoadingState: setLoadingStateFor,
          deferStreamCleanup: recoveryEnabled,
          signal: controller.signal,
          turnId: turnId ?? undefined,
          modelDisplayName: model.name,
          resolveModelDisplayName: (modelName) =>
            models.find((candidate) => candidate.modelName === modelName)?.name,
          onInterrupted: (message) => {
            activeGeneration.latestAssistantMessage = message
          },
        })
        if (assistantMessage && turnId) {
          assistantMessage.turnId = turnId
        }

        const hasAssistantMessageToSave =
          !!assistantMessage && hasVisibleAssistantMessage(assistantMessage)
        if (assistantMessage && hasAssistantMessageToSave) {
          activeGeneration.latestAssistantMessage = assistantMessage
        }

        if (assistantMessage && hasAssistantMessageToSave) {
          // Use this stream's own id (already reflects blank-chat conversion).
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
          let liveChat = findLiveChat(chatId)
          let resolvedTitle = liveChat?.title ?? updatedChat.title
          let resolvedTitleState =
            liveChat?.titleState ?? updatedChat.titleState
          let generatedTitle = false
          if (
            isFirstMessage &&
            resolvedTitle === DEFAULT_CHAT_TITLE &&
            earlyTitlePromise
          ) {
            try {
              const generated = await earlyTitlePromise
              liveChat = findLiveChat(chatId) ?? liveChat
              resolvedTitle = liveChat?.title ?? resolvedTitle
              resolvedTitleState = liveChat?.titleState ?? resolvedTitleState
              if (
                generated &&
                generated !== DEFAULT_CHAT_TITLE &&
                resolvedTitle === DEFAULT_CHAT_TITLE &&
                resolvedTitleState === 'placeholder'
              ) {
                resolvedTitle = generated
                resolvedTitleState = 'generated'
                generatedTitle = true
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

          const isTemporary = liveChat?.isTemporary ?? updatedChat.isTemporary
          const chatToSave = {
            ...updatedChat,
            ...liveChat,
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
            pendingSave: !isTemporary,
          }
          const generatedTitlePatch = (): Partial<Chat> => {
            const latestChat = findLiveChat(chatId)
            return generatedTitle &&
              latestChat?.title === DEFAULT_CHAT_TITLE &&
              latestChat.titleState === 'placeholder'
              ? { title: resolvedTitle, titleState: resolvedTitleState }
              : {}
          }
          const persistFinalChat = (allowCloudSyncWhileStreaming = false) =>
            updateChatWithHistoryCheck(
              setChats,
              chatToSave,
              setCurrentChat,
              chatId,
              finalMessages,
              {
                allowCloudSyncWhileStreaming,
                metadataPatch: {
                  pendingSave: chatToSave.pendingSave,
                  ...generatedTitlePatch(),
                },
              },
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
              await waitForRecoveryReady(response, controller.signal)
              const titleBeforeRecovery = findLiveChat(chatId)
              const completedChat = await completeLiveChatRecovery({
                chatId,
                turnId,
                assistantMessage,
                chatPatch: {
                  ...(generatedTitle
                    ? {
                        title: resolvedTitle,
                        titleState: resolvedTitleState,
                        expectedTitleState: 'placeholder' as const,
                      }
                    : {}),
                },
              })
              const latestChat = findLiveChat(chatId)
              const titleChangedDuringRecovery =
                latestChat !== undefined &&
                (latestChat.title !== titleBeforeRecovery?.title ||
                  latestChat.titleState !== titleBeforeRecovery?.titleState)
              const visibleChat = titleChangedDuringRecovery
                ? {
                    ...completedChat,
                    title: latestChat.title,
                    titleState: latestChat.titleState,
                  }
                : completedChat
              setChats((previous) =>
                previous.map((chat) =>
                  chat.id === chatId ? visibleChat : chat,
                ),
              )
              setCurrentChat((previous) =>
                previous.id === chatId ? visibleChat : previous,
              )
            } catch (error) {
              if (!controller.signal.aborted) {
                await abandonAndReleaseRecovery(chatId)
              }
              if (controller.signal.aborted) {
                throw error
              }
              logError('Failed to finalize recoverable chat response', error, {
                component: 'useChatMessaging',
                action: 'handleQuery.recoveryComplete',
                metadata: { chatId },
              })
              persistFinalChat(true)
            }
          } else {
            persistFinalChat()
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
        if (!controller.signal.aborted) {
          await abandonAndReleaseRecovery(streamChatIdRef.current)
        }
        const wasAborted = controller.signal.aborted
        if (!wasAborted) {
          if (
            typeof userId === 'string' &&
            canUseChatRecovery({ isSignedIn, userId, storeHistory })
          ) {
            void scanPendingChatRecoveries(userId)
          }
        }
        // Ensure UI loading flags are reset on pre-stream errors. Skip if a
        // newer stream owns this chat's controller slot (this stream was
        // aborted and superseded); resetting then would clear the
        // successor's flags mid-stream.
        if (ownsController(streamChatIdRef.current, controller)) {
          setIsWaitingForResponseFor(false)
          setIsStreamingFor(false)
          if (!wasAborted) setLoadingStateFor('idle')
          setIsThinkingFor(false)
        }
        if (!wasAborted) {
          logError('Chat query failed', error, {
            component: 'useChatMessaging',
            action: 'handleQuery',
          })

          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error occurred'
          // Classify by structured signals only (error codes and HTTP
          // status), never by message text.
          const chatError = error instanceof ChatError ? error : null
          const status = (error as { status?: unknown })?.status
          const isHourlyRateLimitError = chatError?.code === 'HOURLY_LIMIT'
          const isRateLimitError =
            isHourlyRateLimitError ||
            chatError?.code === 'RATE_LIMIT' ||
            status === 429

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
            )
          } else {
            // Surface as a dismissable floating banner instead of a chat message
            setStreamErrorFor({
              message: errorMsg,
              code: chatError?.code ?? null,
            })
          }
        }
      } finally {
        if (pendingStreamId !== null) {
          streamingTracker.endPendingStream(pendingStreamId)
        }

        // Refresh rate limit from server for free-tier users so the
        // banner/send-blocking reflects the server's actual count
        // (covers both success and error paths, e.g. 429 responses).
        if (getRateLimitInfo() !== null) {
          refreshRateLimit()
        }

        // Settle this stream's status (preserving any streamError so the
        // banner can surface when the user returns to the chat). Only if
        // this stream still owns the chat's controller slot: an aborted
        // stream can reach this finally block after a newer stream has
        // registered its own controller for the same chat, and patching
        // then would stomp the successor's flags mid-stream.
        const ownsStream = ownsController(streamChatIdRef.current, controller)
        if (ownsStream) {
          patchStatus(streamChatIdRef.current, {
            ...(controller.signal.aborted ? {} : { loadingState: 'idle' }),
            retryInfo: null,
            isWaitingForResponse: false,
            isStreaming: false,
            isThinking: false,
          })
        }
        clearController(streamChatIdRef.current, controller)
        if (
          activeLiveGenerationsRef.current.get(startingChatId) ===
          activeGeneration
        ) {
          activeLiveGenerationsRef.current.delete(startingChatId)
        }
        if (!controller.signal.aborted && ownsStream) {
          // Covers pre-stream failures where the processor (which normally
          // ends streaming) never ran. Idempotent if already ended.
          streamingTracker.endStreaming(streamChatIdRef.current)
        }
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
      findLiveChat,
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
      isRecoveryActive,
      patchStatus,
      resetStatus,
      moveStatus,
      registerController,
      clearController,
      ownsController,
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

  /**
   * Retry a single failed GenUI tool call without regenerating the whole
   * assistant response. Re-asks the model for just that widget's arguments
   * via a structured completion, validates them against the widget schema,
   * and patches the failed block (and its `toolCalls` mirror) in place.
   *
   * Returns true when the widget was repaired; false lets the caller fall
   * back to a full regeneration.
   */
  const retryToolCall = useCallback(
    async (messageIndex: number, toolCallId: string): Promise<boolean> => {
      if (loadingState !== 'idle' || !currentChat) return false

      const chatId = currentChat.id
      const message = currentChat.messages[messageIndex]
      if (!message || message.role !== 'assistant') return false
      const block = message.timeline?.find(
        (candidate) =>
          candidate.type === 'tool_call' && candidate.toolCallId === toolCallId,
      )
      if (!block || block.type !== 'tool_call') return false

      const { model } = resolveModelSelection(selectedModel, models, {})
      if (!model) return false

      const newArguments = await regenerateToolCallArguments({
        toolName: block.name,
        originalArguments: block.arguments,
        contextMessages: currentChat.messages.slice(0, messageIndex + 1),
        model,
      })
      if (newArguments === null) return false

      const patchMessage = (msg: Message): Message => ({
        ...msg,
        timeline: msg.timeline?.map((candidate) =>
          candidate.type === 'tool_call' && candidate.toolCallId === toolCallId
            ? { ...candidate, arguments: newArguments }
            : candidate,
        ),
        toolCalls: msg.toolCalls?.map((tc) =>
          tc.id === toolCallId ? { ...tc, arguments: newArguments } : tc,
        ),
      })

      // The model call above can take seconds; the chat may have gained
      // messages (or the user may have switched away) since the closure
      // captured `currentChat`. Patch the tool-call block by id against
      // the *live* state instead of writing the snapshot back, so the
      // repair can never roll back newer chat content.
      const patchChat = (chat: Chat): Chat => ({
        ...chat,
        messages: chat.messages.map((msg) =>
          msg.role === 'assistant' &&
          msg.timeline?.some(
            (candidate) =>
              candidate.type === 'tool_call' &&
              candidate.toolCallId === toolCallId,
          )
            ? patchMessage(msg)
            : msg,
        ),
      })

      setChats((prevChats) =>
        prevChats.map((c) => (c.id === chatId ? patchChat(c) : c)),
      )
      setCurrentChat((prev) => (prev.id === chatId ? patchChat(prev) : prev))

      const liveChat =
        chatsRef.current.find((c) => c.id === chatId) ??
        (currentChat.id === chatId ? currentChat : null)
      const chatToSave = liveChat ? patchChat(liveChat) : null
      if (chatToSave && !chatToSave.isTemporary) {
        if (storeHistory) {
          chatStorage.saveChatAndSync(chatToSave).catch((error) => {
            logError('Failed to persist repaired widget', error, {
              component: 'useChatMessaging',
              action: 'retryToolCall',
              metadata: { chatId, toolCallId },
            })
          })
        } else {
          sessionChatStorage.saveChat(chatToSave)
        }
      }

      return true
    },
    [
      loadingState,
      currentChat,
      selectedModel,
      models,
      storeHistory,
      setChats,
      setCurrentChat,
    ],
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
    retryToolCall,
  }
}
