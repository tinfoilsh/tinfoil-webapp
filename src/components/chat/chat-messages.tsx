import {
  findSelectableModel,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@/config/models'
import { useChatPrint } from '@/hooks/use-chat-print'
import {
  REASONING_HISTORY_POLICIES,
  type ReasoningHistoryPolicy,
} from '@/utils/reasoning-history'
import {
  findContextStartIndex,
  getHistoryTokenBudget,
  resolveContextWindowTokens,
} from '@/utils/token-estimation'
import 'katex/dist/katex.min.css'
import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { canRemoveChatSpacerWithoutJump } from './chat-scroll'
import { CONSTANTS } from './constants'
import { ensureTimeline } from './ensure-timeline'
import type { ReasoningEffort } from './hooks/use-reasoning-effort'
import { ImageGalleryProvider } from './image-gallery-context'
import { PrintableChat } from './PrintableChat'
import type { PromptPreset } from './prompts/types'
import { getRendererRegistry } from './renderers/client'
import { StreamingTracerDot } from './renderers/components/StreamingTracerDot'
import type { LabelType, Message, PendingRecoveryEnvelope } from './types'
import { WelcomeScreen } from './WelcomeScreen'

type ChatMessagesProps = {
  messages: Message[]
  pendingRecoveries?: PendingRecoveryEnvelope[]
  recoveryDrafts?: ReadonlyArray<{ turnId: string; message: Message }>
  activeRecoveryTurnIds?: readonly string[]
  reasoningHistoryPolicy?: ReasoningHistoryPolicy
  contextWindowTokens?: number
  pendingContextTokens?: number
  isDarkMode: boolean
  chatId: string
  isWaitingForResponse?: boolean
  isStreamingResponse?: boolean
  activeArtifactToolCallId?: string | null
  isPremium?: boolean
  models?: BaseModel[]
  onSubmit?: (e: React.FormEvent) => void
  input?: string
  setInput?: (value: string) => void
  loadingState?: any
  retryInfo?: { attempt: number; maxRetries: number; error?: string } | null
  cancelGeneration?: () => void
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  handleInputFocus?: () => void
  handleDocumentUpload?: (file: File) => Promise<void>
  processedDocuments?: any[]
  removeDocument?: (id: string) => void
  selectedModel?: string
  handleModelSelect?: (model: string) => void
  expandedLabel?: LabelType
  handleLabelClick?: (
    label: Exclude<LabelType, null>,
    action: () => void,
  ) => void
  onEditMessage?: (messageIndex: number, newContent: string) => void
  onRegenerateMessage?: (messageIndex: number) => void
  onDeleteMessage?: (messageIndex: number) => void
  onEditAssistantMessage?: (messageIndex: number, newContent: string) => void
  onContinueAssistantMessage?: (messageIndex: number) => void
  onRetryToolCall?: (
    messageIndex: number,
    toolCallId: string,
  ) => Promise<boolean>
  showScrollButton?: boolean
  webSearchEnabled?: boolean
  onWebSearchToggle?: () => void
  reasoningEffort?: ReasoningEffort
  setReasoningEffort?: (effort: ReasoningEffort) => void
  thinkingEnabled?: boolean
  setThinkingEnabled?: (enabled: boolean) => void
  autoIntelligence: AutoIntelligenceLevelId
  setAutoIntelligence: (level: AutoIntelligenceLevelId) => void
  codeExecutionEnabled?: boolean
  onCodeExecutionToggle?: () => void
  isTemporaryMode?: boolean
  activePromptPreset?: PromptPreset | null
  onOpenPromptLibrary?: () => void
  onSelectPromptPreset?: (presetId: string | null) => void
}

function getMessageActiveArtifactToolCallId(
  message: Message,
  activeArtifactToolCallId?: string | null,
): string | null {
  if (!activeArtifactToolCallId) return null
  const isActive =
    message.toolCalls?.some(
      (toolCall) => toolCall.id === activeArtifactToolCallId,
    ) ||
    message.timeline?.some(
      (block) =>
        block.type === 'tool_call' &&
        block.toolCallId === activeArtifactToolCallId,
    )
  return isActive ? activeArtifactToolCallId : null
}

// Optimized wrapper component that receives expanded state from parent
const ChatMessage = memo(
  function ChatMessage({
    message,
    messageIndex,
    model,
    isDarkMode,
    isLastMessage = false,
    isStreaming = false,
    activeArtifactToolCallId,
    hideActions = false,
    onEditMessage,
    onRegenerateMessage,
    onDeleteMessage,
    onEditAssistantMessage,
    onContinueAssistantMessage,
    onRetryToolCall,
  }: {
    message: Message
    messageIndex: number
    model: BaseModel
    isDarkMode: boolean
    isLastMessage?: boolean
    isStreaming?: boolean
    activeArtifactToolCallId?: string | null
    hideActions?: boolean
    onEditMessage?: (messageIndex: number, newContent: string) => void
    onRegenerateMessage?: (messageIndex: number) => void
    onDeleteMessage?: (messageIndex: number) => void
    onEditAssistantMessage?: (messageIndex: number, newContent: string) => void
    onContinueAssistantMessage?: (messageIndex: number) => void
    onRetryToolCall?: (
      messageIndex: number,
      toolCallId: string,
    ) => Promise<boolean>
  }) {
    const normalized = ensureTimeline(message)
    const renderer = getRendererRegistry().getMessageRenderer(normalized, model)
    const RendererComponent = renderer.render

    return (
      <RendererComponent
        message={normalized}
        messageIndex={messageIndex}
        model={model}
        isDarkMode={isDarkMode}
        isLastMessage={isLastMessage}
        isStreaming={isStreaming}
        activeArtifactToolCallId={activeArtifactToolCallId}
        hideActions={hideActions}
        onEditMessage={onEditMessage}
        onRegenerateMessage={onRegenerateMessage}
        onDeleteMessage={onDeleteMessage}
        onEditAssistantMessage={onEditAssistantMessage}
        onContinueAssistantMessage={onContinueAssistantMessage}
        onRetryToolCall={onRetryToolCall}
      />
    )
  },
  (prevProps, nextProps) => {
    // toMessage() creates a new Message object on every streaming chunk,
    // so reference equality naturally re-renders the active message.
    // Non-streaming messages keep stable references from the messages array.
    return (
      prevProps.message === nextProps.message &&
      prevProps.messageIndex === nextProps.messageIndex &&
      prevProps.model === nextProps.model &&
      prevProps.isDarkMode === nextProps.isDarkMode &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.isStreaming === nextProps.isStreaming &&
      prevProps.activeArtifactToolCallId ===
        nextProps.activeArtifactToolCallId &&
      prevProps.hideActions === nextProps.hideActions &&
      prevProps.onEditMessage === nextProps.onEditMessage &&
      prevProps.onRegenerateMessage === nextProps.onRegenerateMessage &&
      prevProps.onDeleteMessage === nextProps.onDeleteMessage &&
      prevProps.onEditAssistantMessage === nextProps.onEditAssistantMessage &&
      prevProps.onContinueAssistantMessage ===
        nextProps.onContinueAssistantMessage &&
      prevProps.onRetryToolCall === nextProps.onRetryToolCall
    )
  },
)

// Loading indicator with EXACT same structure as collapsed ThoughtProcess
const LoadingMessage = memo(function LoadingMessage({
  isDarkMode,
  isRetrying = false,
  retryInfo,
}: {
  isDarkMode: boolean
  isRetrying?: boolean
  retryInfo?: { attempt: number; maxRetries: number; error?: string } | null
}) {
  const getRetryMessage = () => {
    if (!retryInfo) return 'Connection issue. Retrying...'

    const { attempt, maxRetries, error } = retryInfo
    let errorType = 'Connection issue'

    if (error) {
      const lowerError = error.toLowerCase()
      if (lowerError.includes('network') || lowerError.includes('fetch')) {
        errorType = 'Network error'
      } else if (
        lowerError.includes('timeout') ||
        lowerError.includes('timed out')
      ) {
        errorType = 'Request timeout'
      } else if (lowerError.includes('rate limit') || error.includes('429')) {
        errorType = 'Rate limited'
      } else if (lowerError.includes('server') || error.includes('500')) {
        errorType = 'Server error'
      }
    }

    return `${errorType}. Attempting retry (${attempt} of ${maxRetries})...`
  }

  return (
    <div className="no-scroll-anchoring group mx-auto mb-6 flex w-full max-w-3xl flex-col items-start px-4 pt-6">
      <div className="flex w-full flex-col gap-2">
        <StreamingTracerDot tone="secondary" />
        {isRetrying && (
          <span className="text-sm text-content-secondary">
            {getRetryMessage()}
          </span>
        )}
      </div>
    </div>
  )
})

const RecoveryMessage = memo(function RecoveryMessage() {
  const titleId = useId()

  return (
    <div
      className="no-scroll-anchoring mx-auto -mt-6 mb-6 flex w-full max-w-3xl px-4"
      role="status"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-2.5 py-1.5">
        <span aria-hidden="true" className="flex h-5 items-center">
          <StreamingTracerDot tone="secondary" />
        </span>
        <span id={titleId} className="text-sm font-medium text-content-primary">
          Recovering stream...
        </span>
      </div>
    </div>
  )
})

const getMessageKey = (
  prefix: string,
  message: Message,
  index: number,
): string => {
  // Use role and timestamp for stable unique keys (no index to avoid reordering issues)
  const timestamp = message.timestamp
    ? message.timestamp instanceof Date
      ? message.timestamp.getTime()
      : String(message.timestamp)
    : `fallback-${index}` // Only use index as fallback when no timestamp
  return `${prefix}-${message.role}-${timestamp}`
}

const MessagesSeparator = memo(function MessagesSeparator({
  isDarkMode,
}: {
  isDarkMode: boolean
}) {
  return (
    <div className={`relative my-6 flex items-center justify-center`}>
      <div className="absolute w-full border-t border-border-subtle"></div>
      <span className="relative bg-surface-chat-background px-4 text-sm font-medium text-content-secondary">
        Archived Messages
      </span>
    </div>
  )
})

export function ChatMessages({
  messages,
  pendingRecoveries = [],
  recoveryDrafts = [],
  activeRecoveryTurnIds = [],
  reasoningHistoryPolicy = REASONING_HISTORY_POLICIES.none,
  contextWindowTokens,
  pendingContextTokens = 0,
  isDarkMode,
  chatId,
  isWaitingForResponse = false,
  isStreamingResponse = false,
  activeArtifactToolCallId,
  isPremium,
  models,
  onSubmit,
  input,
  setInput,
  loadingState,
  retryInfo,
  cancelGeneration,
  inputRef,
  handleInputFocus,
  handleDocumentUpload,
  processedDocuments,
  removeDocument,
  selectedModel,
  handleModelSelect,
  expandedLabel,
  handleLabelClick,
  onEditMessage,
  onRegenerateMessage,
  onDeleteMessage,
  onEditAssistantMessage,
  onContinueAssistantMessage,
  onRetryToolCall,
  showScrollButton,
  webSearchEnabled,
  onWebSearchToggle,
  reasoningEffort,
  setReasoningEffort,
  thinkingEnabled,
  setThinkingEnabled,
  autoIntelligence,
  setAutoIntelligence,
  codeExecutionEnabled,
  onCodeExecutionToggle,
  isTemporaryMode,
  activePromptPreset,
  onOpenPromptLibrary,
  onSelectPromptPreset,
}: ChatMessagesProps) {
  const [mounted, setMounted] = useState(false)
  const [showSpacer, setShowSpacer] = useState(false)
  const prevMessageCountRef = React.useRef(messages.length)
  const messageCountWhenSpacerSetRef = React.useRef<number | null>(null)
  const spacerRef = React.useRef<HTMLDivElement>(null)
  const printRef = useRef<HTMLDivElement>(null)
  const printReadyResolverRef = useRef<(() => void) | null>(null)
  const [printRequested, setPrintRequested] = useState(false)
  const [expandedArchiveChatId, setExpandedArchiveChatId] = useState<
    string | null
  >(null)

  const preparePrint = useCallback(async () => {
    await new Promise<void>((resolve) => {
      printReadyResolverRef.current = resolve
      setPrintRequested(true)
    })
  }, [])

  useLayoutEffect(() => {
    if (!printRequested) return
    printReadyResolverRef.current?.()
    printReadyResolverRef.current = null
  }, [printRequested])

  useEffect(() => {
    const resolver = printReadyResolverRef
    return () => {
      resolver.current?.()
      resolver.current = null
    }
  }, [])

  const cleanupPrint = useCallback(() => {
    printReadyResolverRef.current?.()
    printReadyResolverRef.current = null
    setPrintRequested(false)
  }, [])

  useChatPrint({
    printRef,
    enabled: messages.length > 0,
    prepare: preparePrint,
    cleanup: cleanupPrint,
  })

  // Show spacer when user sends a new message
  React.useEffect(() => {
    const lastMessage = messages[messages.length - 1]
    if (
      messages.length > prevMessageCountRef.current &&
      lastMessage?.role === 'user'
    ) {
      setShowSpacer(true)
      messageCountWhenSpacerSetRef.current = messages.length
    }
    prevMessageCountRef.current = messages.length
  }, [messages])

  // Reset spacer when chat changes
  React.useEffect(() => {
    setShowSpacer(false)
    prevMessageCountRef.current = messages.length
    messageCountWhenSpacerSetRef.current = null
  }, [chatId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset spacer after an active response has grown beyond the viewport
  React.useEffect(() => {
    const spacerSetForCurrentMessage =
      messageCountWhenSpacerSetRef.current === messages.length
    const spacer = spacerRef.current
    const scrollContainer = spacer?.closest(
      '[data-scroll-container="main"]',
    ) as HTMLElement | null

    if (
      !isStreamingResponse &&
      !spacerSetForCurrentMessage &&
      spacer &&
      scrollContainer &&
      canRemoveChatSpacerWithoutJump(
        scrollContainer.scrollHeight,
        scrollContainer.scrollTop,
        scrollContainer.clientHeight,
        spacer.offsetHeight,
      )
    ) {
      setShowSpacer(false)
    }
  }, [showScrollButton, messages.length, isStreamingResponse])

  // Get the current model - always defined since config must load
  const currentModel = useMemo(() => {
    if (!models || models.length === 0 || !selectedModel) {
      // This should never happen since chat interface doesn't load without config
      // but TypeScript needs this check
      return models?.[0] || null
    }
    return findSelectableModel(selectedModel, models) || models[0]
  }, [models, selectedModel])

  // Separate messages into archived and live sections - memoize this calculation
  const computedArchiveStartIndex = useMemo(() => {
    const budget = getHistoryTokenBudget(
      contextWindowTokens ??
        resolveContextWindowTokens(currentModel ?? undefined),
      pendingContextTokens,
    )
    return findContextStartIndex(messages, budget, {
      reasoningHistoryPolicy,
      keepMostRecent: pendingContextTokens === 0,
    })
  }, [
    messages,
    contextWindowTokens,
    currentModel,
    reasoningHistoryPolicy,
    pendingContextTokens,
  ])
  const [archiveBoundary, setArchiveBoundary] = useState(() => ({
    chatId,
    initialized: messages.length > 0,
    startIndex: computedArchiveStartIndex,
  }))
  let archiveStartIndex: number
  if (archiveBoundary.chatId !== chatId) {
    archiveStartIndex = computedArchiveStartIndex
    setArchiveBoundary({
      chatId,
      initialized: messages.length > 0,
      startIndex: archiveStartIndex,
    })
  } else if (messages.length === 0) {
    archiveStartIndex = 0
    if (archiveBoundary.initialized || archiveBoundary.startIndex !== 0) {
      setArchiveBoundary({
        chatId,
        initialized: false,
        startIndex: 0,
      })
    }
  } else if (!archiveBoundary.initialized && messages.length > 0) {
    archiveStartIndex = computedArchiveStartIndex
    setArchiveBoundary({
      chatId,
      initialized: true,
      startIndex: archiveStartIndex,
    })
  } else {
    archiveStartIndex = Math.min(
      archiveBoundary.startIndex,
      computedArchiveStartIndex,
      messages.length,
    )
    if (archiveStartIndex !== archiveBoundary.startIndex) {
      setArchiveBoundary({
        ...archiveBoundary,
        startIndex: archiveStartIndex,
      })
    }
  }
  const { archivedMessages, liveMessages } = useMemo(
    () => ({
      archivedMessages: messages.slice(0, archiveStartIndex),
      liveMessages: messages.slice(archiveStartIndex),
    }),
    [archiveStartIndex, messages],
  )

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div className="h-full"></div>
  }

  if (messages.length === 0 && !isWaitingForResponse) {
    return (
      <div className="relative flex min-h-full w-full flex-col items-center overflow-y-auto">
        {/* Asymmetric spacers bias the panel above center so the model menu,
            which opens below the input, has room on tall screens. */}
        <div className="flex-[2]" />
        <div className="relative z-10 w-full max-w-4xl px-8 pb-8 pt-16">
          <WelcomeScreen
            isDarkMode={isDarkMode}
            isPremium={isPremium}
            models={models}
            onSubmit={onSubmit}
            input={input}
            setInput={setInput}
            loadingState={loadingState}
            cancelGeneration={cancelGeneration}
            inputRef={inputRef}
            handleInputFocus={handleInputFocus}
            handleDocumentUpload={handleDocumentUpload}
            processedDocuments={processedDocuments}
            removeDocument={removeDocument}
            selectedModel={selectedModel}
            handleModelSelect={handleModelSelect}
            expandedLabel={expandedLabel as LabelType}
            handleLabelClick={handleLabelClick}
            webSearchEnabled={webSearchEnabled}
            onWebSearchToggle={onWebSearchToggle}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={setReasoningEffort}
            thinkingEnabled={thinkingEnabled}
            setThinkingEnabled={setThinkingEnabled}
            autoIntelligence={autoIntelligence}
            setAutoIntelligence={setAutoIntelligence}
            codeExecutionEnabled={codeExecutionEnabled}
            onCodeExecutionToggle={onCodeExecutionToggle}
            isTemporaryMode={isTemporaryMode}
            activePromptPreset={activePromptPreset}
            onOpenPromptLibrary={onOpenPromptLibrary}
            onSelectPromptPreset={onSelectPromptPreset}
          />
        </div>
        <div className="flex-[3]" />
      </div>
    )
  }

  // Early return if no model (should never happen)
  if (!currentModel) {
    return <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-24"></div>
  }

  // Show loading dots only while waiting on a fresh response. When the last
  // message is already an assistant bubble being streamed into (thinking
  // has started, or a continuation is resuming it) that bubble carries its
  // own indicator.
  const lastMessage = liveMessages[liveMessages.length - 1]
  const showLoadingPlaceholder =
    isWaitingForResponse &&
    !(
      lastMessage?.role === 'assistant' &&
      (isStreamingResponse ||
        lastMessage.isThinking ||
        (lastMessage.thoughts && !lastMessage.content))
    )
  const pendingRecoveryTurnIds = new Set(
    pendingRecoveries.map((recovery) => recovery.turnId),
  )
  const recoveryDraftsByTurnId = new Map(
    recoveryDrafts.map((draft) => [draft.turnId, draft.message]),
  )
  const persistedAssistantTurnIds = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant' && message.turnId ? [message.turnId] : [],
    ),
  )
  const activeRecoveryTurns = new Set(
    activeRecoveryTurnIds.filter((turnId) =>
      pendingRecoveryTurnIds.has(turnId),
    ),
  )
  const activeOrDraftingRecoveryTurns = new Set(activeRecoveryTurns)
  for (const draft of recoveryDrafts) {
    if (pendingRecoveryTurnIds.has(draft.turnId)) {
      activeOrDraftingRecoveryTurns.add(draft.turnId)
    }
  }
  const archiveHasActiveRecovery = archivedMessages.some(
    (message) =>
      message.turnId !== undefined &&
      activeOrDraftingRecoveryTurns.has(message.turnId),
  )
  // Latch the archive open while a recovery streams into it, so the recovered
  // turn stays visible after its envelope clears instead of collapsing away.
  if (archiveHasActiveRecovery && expandedArchiveChatId !== chatId) {
    setExpandedArchiveChatId(chatId)
  }
  const showArchivedMessages =
    expandedArchiveChatId === chatId || archiveHasActiveRecovery
  const hasActiveRecovery =
    activeRecoveryTurns.size > 0 ||
    recoveryDrafts.some((draft) => pendingRecoveryTurnIds.has(draft.turnId))
  const activeTurnCandidate =
    isWaitingForResponse || isStreamingResponse
      ? [...messages].reverse().find((message) => message.role === 'user')
          ?.turnId
      : undefined
  const activeTurnId =
    activeTurnCandidate && !activeRecoveryTurns.has(activeTurnCandidate)
      ? activeTurnCandidate
      : undefined
  const showRecoveryAfter = (message: Message) =>
    message.role === 'user' &&
    message.turnId !== undefined &&
    message.turnId !== activeTurnId &&
    pendingRecoveryTurnIds.has(message.turnId) &&
    !persistedAssistantTurnIds.has(message.turnId)
  const recoveryDraftForMessage = (message: Message) =>
    message.role === 'assistant' &&
    message.turnId &&
    message.turnId !== activeTurnId &&
    pendingRecoveryTurnIds.has(message.turnId)
      ? recoveryDraftsByTurnId.get(message.turnId)
      : undefined
  const showRecoveryStatusAfter = (message: Message) =>
    message.role === 'assistant' &&
    message.turnId !== undefined &&
    message.turnId !== activeTurnId &&
    pendingRecoveryTurnIds.has(message.turnId) &&
    !recoveryDraftsByTurnId.has(message.turnId)
  const renderRecoveryAfter = (message: Message, messageIndex: number) => {
    if (!showRecoveryAfter(message)) return null
    const draft = message.turnId
      ? recoveryDraftsByTurnId.get(message.turnId)
      : undefined
    return (
      <>
        {draft && (
          <ChatMessage
            message={draft}
            messageIndex={messageIndex + 1}
            model={currentModel}
            isDarkMode={isDarkMode}
            isLastMessage
            isStreaming
            activeArtifactToolCallId={getMessageActiveArtifactToolCallId(
              draft,
              activeArtifactToolCallId,
            )}
          />
        )}
        {!draft && <RecoveryMessage />}
      </>
    )
  }

  return (
    <ImageGalleryProvider messages={messages}>
      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={isStreamingResponse || hasActiveRecovery}
        className="mx-auto w-full min-w-0 px-0 pb-6 pt-24 font-chat md:px-4"
      >
        {/* Archived Messages - only shown if there are more than the max prompt messages */}
        {archivedMessages.length > 0 && (
          <>
            {!showArchivedMessages && (
              <div className="flex justify-center px-4 pb-8">
                <button
                  type="button"
                  onClick={() => setExpandedArchiveChatId(chatId)}
                  className="hover:bg-surface-secondary rounded-full border border-border-subtle bg-surface-chat px-4 py-2 text-sm text-content-secondary transition-colors hover:text-content-primary"
                >
                  Show {archivedMessages.length} earlier messages
                </button>
              </div>
            )}
            {showArchivedMessages && (
              <div className="opacity-70">
                {archivedMessages.map((message, i) => {
                  const key = getMessageKey(`${chatId}-archived`, message, i)
                  const recoveryDraft = recoveryDraftForMessage(message)
                  return (
                    <React.Fragment key={key}>
                      <ChatMessage
                        message={recoveryDraft ?? message}
                        messageIndex={i}
                        model={currentModel}
                        isDarkMode={isDarkMode}
                        isLastMessage={Boolean(recoveryDraft)}
                        isStreaming={Boolean(recoveryDraft)}
                        activeArtifactToolCallId={getMessageActiveArtifactToolCallId(
                          recoveryDraft ?? message,
                          activeArtifactToolCallId,
                        )}
                        onEditMessage={
                          recoveryDraft ? undefined : onEditMessage
                        }
                        onRegenerateMessage={
                          recoveryDraft ? undefined : onRegenerateMessage
                        }
                        onDeleteMessage={
                          recoveryDraft ? undefined : onDeleteMessage
                        }
                        onEditAssistantMessage={
                          recoveryDraft ? undefined : onEditAssistantMessage
                        }
                        onContinueAssistantMessage={
                          recoveryDraft ? undefined : onContinueAssistantMessage
                        }
                        onRetryToolCall={
                          recoveryDraft ? undefined : onRetryToolCall
                        }
                      />
                      {showRecoveryStatusAfter(message) && <RecoveryMessage />}
                      {renderRecoveryAfter(message, i)}
                    </React.Fragment>
                  )
                })}
              </div>
            )}

            {showArchivedMessages && (
              <MessagesSeparator isDarkMode={isDarkMode} />
            )}
          </>
        )}

        {/* Live Messages - the last messages up to max prompt limit */}
        {liveMessages.map((message, i) => {
          const key = getMessageKey(`${chatId}-live`, message, i)
          const recoveryDraft = recoveryDraftForMessage(message)
          return (
            <React.Fragment key={key}>
              <ChatMessage
                message={recoveryDraft ?? message}
                messageIndex={archivedMessages.length + i}
                model={currentModel}
                isDarkMode={isDarkMode}
                isLastMessage={
                  Boolean(recoveryDraft) || i === liveMessages.length - 1
                }
                isStreaming={
                  Boolean(recoveryDraft) ||
                  (i === liveMessages.length - 1 && isStreamingResponse)
                }
                activeArtifactToolCallId={getMessageActiveArtifactToolCallId(
                  recoveryDraft ?? message,
                  activeArtifactToolCallId,
                )}
                onEditMessage={recoveryDraft ? undefined : onEditMessage}
                onRegenerateMessage={
                  recoveryDraft ? undefined : onRegenerateMessage
                }
                onDeleteMessage={recoveryDraft ? undefined : onDeleteMessage}
                onEditAssistantMessage={
                  recoveryDraft ? undefined : onEditAssistantMessage
                }
                onContinueAssistantMessage={
                  recoveryDraft ? undefined : onContinueAssistantMessage
                }
                onRetryToolCall={recoveryDraft ? undefined : onRetryToolCall}
              />
              {showRecoveryStatusAfter(message) && <RecoveryMessage />}
              {renderRecoveryAfter(message, archivedMessages.length + i)}
            </React.Fragment>
          )
        })}
        {showLoadingPlaceholder && (
          <LoadingMessage
            isDarkMode={isDarkMode}
            isRetrying={loadingState === 'retrying'}
            retryInfo={retryInfo}
          />
        )}
        {/* Spacer allows scrollIntoView to bring user message to top of viewport.
          Subtracts the composer height (set on the scroll container as
          --input-area-height) so the total over-scroll is just enough for the
          fade above the input area, not a full 70dvh of empty space. */}
        {showSpacer && (
          <div
            ref={spacerRef}
            data-spacer
            className="flex-shrink-0"
            style={{
              height: `max(0px, calc(70dvh - var(--input-area-height, 0px) - ${CONSTANTS.CHAT_INPUT_BOTTOM_GAP_PX}px))`,
            }}
            aria-hidden="true"
          />
        )}
        {printRequested && (
          <PrintableChat messages={messages} printRef={printRef} />
        )}
      </div>
    </ImageGalleryProvider>
  )
}
