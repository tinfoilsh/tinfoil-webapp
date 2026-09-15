import type { AutoIntelligenceLevelId } from '@/config/models'
import { isModelNameAvailable, type BaseModel } from '@/config/models'
import { useExecSnapshot } from '@/services/exec-snapshot/use-exec-snapshot'
import { logWarning } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AIModel, Chat, LabelType, LoadingState, Message } from '../types'
import { useChatMessaging, type ChatDispatchResult } from './use-chat-messaging'
import { useChatStorage } from './use-chat-storage'
import type { StreamErrorInfo } from './use-chat-streams'
import {
  resolveChatModel,
  shouldCloseMenuOnSelect,
  useModelManagement,
} from './use-model-management'
import type { ReasoningEffort } from './use-reasoning-effort'
import { useUIState, type ThemeMode } from './use-ui-state'

// Return type for useChatState hook
interface UseChatStateReturn {
  // State
  chats: Chat[]
  currentChat: Chat
  input: string
  loadingState: LoadingState
  retryInfo: { attempt: number; maxRetries: number; error?: string } | null
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  isClient: boolean
  isSidebarOpen: boolean
  isDarkMode: boolean
  themeMode: ThemeMode
  isInitialLoad: boolean
  isChatHydrating: boolean
  isThinking: boolean
  isWaitingForResponse: boolean
  isStreaming: boolean
  streamError: StreamErrorInfo | null
  dismissStreamError: () => void
  selectedModel: AIModel
  hasValidatedModel: boolean
  expandedLabel: LabelType
  windowWidth: number
  codeExecutionEncryptionKey: string | null

  // Setters
  setInput: (input: string) => void
  setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsInitialLoad: (isLoading: boolean) => void
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>

  // Actions
  handleSubmit: (e: React.FormEvent) => void
  handleQuery: (
    query: string,
    attachments?: import('@/components/chat/types').Attachment[],
    systemPromptOverride?: string,
    baseMessages?: Message[],
    quote?: string,
    onReadyForNextMessage?: () => void,
  ) => Promise<ChatDispatchResult>
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  deleteChat: (chatId: string) => void
  handleChatSelect: (chatId: string) => void
  loadChatById: (chatId: string, isLocalUrl: boolean) => Promise<void>
  toggleTheme: () => void
  setThemeMode: (mode: ThemeMode) => void
  openAndExpandVerifier: () => void
  handleInputFocus: () => void
  handleLabelClick: (
    label: Exclude<LabelType, null>,
    action: () => void,
  ) => void
  handleModelSelect: (modelName: AIModel) => void
  cancelGeneration: (chatId?: string) => Promise<void>
  updateChatTitle: (chatId: string, newTitle: string) => void
  reloadChats: () => Promise<void>
  editMessage: (messageIndex: number, newContent: string) => void
  deleteMessage: (messageIndex: number) => void
  editAssistantMessage: (messageIndex: number, newContent: string) => void
  continueAssistantMessage: (
    messageIndex: number,
    editedContent?: string,
  ) => void
  regenerateMessage: (messageIndex: number) => void
  retryLastMessage: () => void
  resolveInputToolCall: (
    toolCallId: string,
    resultText: string,
    resultData?: unknown,
  ) => void
  retryToolCall: (messageIndex: number, toolCallId: string) => Promise<boolean>
  initialChatDecryptionFailed: boolean
  clearInitialChatDecryptionFailed: () => void
  localChatNotFound: boolean
  initialChatLoadFailed: boolean
  cloudChatNotFound: boolean
  retryInitialChatLoad: () => void
}

export function useChatState({
  systemPrompt,
  rules = '',
  storeHistory = true,
  models = [],
  scrollToBottom,
  reasoningEffort,
  thinkingEnabled,
  autoIntelligence,
  initialChatId,
  isLocalChatUrl = false,
  initialNewChatIsLocalOnly = false,
  webSearchAvailable,
  canUseCodeExecution = false,
  codeExecutionEnabled,
  piiCheckEnabled,
  genUIEnabled,
}: {
  systemPrompt: string
  rules?: string
  storeHistory?: boolean
  models?: BaseModel[]
  scrollToBottom?: () => void
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  autoIntelligence?: AutoIntelligenceLevelId
  initialChatId?: string | null
  isLocalChatUrl?: boolean
  initialNewChatIsLocalOnly?: boolean
  webSearchAvailable?: boolean
  // Feature flag: when false, useExecSnapshot stays a no-op and no
  // key material is derived. Distinct from `codeExecutionEnabled`,
  // which is the user-facing toggle.
  canUseCodeExecution?: boolean
  codeExecutionEnabled?: boolean
  piiCheckEnabled?: boolean
  genUIEnabled?: boolean
}): UseChatStateReturn {
  const hasCreatedInitialChatRef = useRef(false)

  // UI State Management
  const {
    isClient,
    isSidebarOpen,
    isDarkMode,
    windowWidth,
    setIsSidebarOpen,
    toggleTheme,
    setThemeMode,
    openAndExpandVerifier,
    handleInputFocus,
    themeMode,
  } = useUIState()

  // Chat Storage Management
  const {
    chats,
    currentChat,
    setChats,
    setCurrentChat,
    createNewChat,
    deleteChat,
    updateChatTitle,
    updateChatModel,
    handleChatSelect,
    loadChatById,
    setIsInitialLoad,
    isInitialLoad,
    isChatHydrating,
    reloadChats,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
    initialChatLoadFailed,
    cloudChatNotFound,
    retryInitialChatLoad,
  } = useChatStorage({
    storeHistory,
    scrollToBottom,
    initialChatId,
    isLocalChatUrl,
    initialNewChatIsLocalOnly,
  })

  // Model Management - the hook owns model validation, the device-local
  // saved model, and the label/verification UI state. The active model
  // itself is per-chat: it is resolved from the current chat (falling
  // back to the saved model, then the first available model) so
  // concurrent chats never override each other.
  const {
    selectedModel: savedModel,
    hasValidatedModel,
    expandedLabel,
    setExpandedLabel,
    handleModelSelect: persistModelSelection,
    handleLabelClick,
  } = useModelManagement({
    models,
    isClient,
  })

  const selectedModel = useMemo(
    () => resolveChatModel(currentChat, models, savedModel),
    [currentChat, models, savedModel],
  )

  const handleModelSelect = useCallback(
    (modelName: AIModel) => {
      if (!isModelNameAvailable(modelName, models)) {
        logWarning(`Model ${modelName} is not available`, {
          component: 'useChatState',
          action: 'handleModelSelect',
          metadata: { modelName },
        })
        return
      }
      updateChatModel(modelName)
      persistModelSelection(modelName)
      if (shouldCloseMenuOnSelect(modelName)) {
        setExpandedLabel(null)
      }
    },
    [models, updateChatModel, persistModelSelection, setExpandedLabel],
  )

  const { codeExecutionEncryptionKey } = useExecSnapshot({
    enabled: canUseCodeExecution,
  })

  // Chat Messaging
  const {
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
    deleteMessage,
    editAssistantMessage,
    continueAssistantMessage,
    regenerateMessage,
    retryLastMessage,
    resolveInputToolCall,
    retryToolCall,
  } = useChatMessaging({
    systemPrompt,
    rules,
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
    autoIntelligence,
    webSearchAvailable,
    // code-exec requires encryptionKey for snapshots
    codeExecutionEnabled:
      codeExecutionEnabled && codeExecutionEncryptionKey != null,
    piiCheckEnabled,
    genUIEnabled,
    codeExecutionEncryptionKey,
  })

  // Add effect to handle dismissing the model selector
  useEffect(() => {
    if (expandedLabel === 'model') {
      const triggerSelector = '[data-model-selector]'
      const menuSelector = '[data-model-menu]'

      const getSelectorElements = () => [
        ...document.querySelectorAll<HTMLElement>(triggerSelector),
        ...document.querySelectorAll<HTMLElement>(menuSelector),
      ]
      const getVisibleTrigger = () =>
        [...document.querySelectorAll<HTMLElement>(triggerSelector)].find(
          (element) => element.getClientRects().length > 0,
        )

      const isOutsideSelector = (target: EventTarget | null) => {
        if (!(target instanceof Node)) return false
        const selectorElements = getSelectorElements()
        return (
          selectorElements.length > 0 &&
          selectorElements.every((element) => !element.contains(target))
        )
      }

      const handleClickOutside = (event: MouseEvent) => {
        if (isOutsideSelector(event.target)) {
          setExpandedLabel(null)
        }
      }

      const handleFocusOutside = (event: FocusEvent) => {
        if (isOutsideSelector(event.target)) {
          setExpandedLabel(null)
        }
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          setExpandedLabel(null)
          getVisibleTrigger()?.focus()
        }
      }

      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('focusin', handleFocusOutside)
      document.addEventListener('keydown', handleKeyDown)

      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('focusin', handleFocusOutside)
        document.removeEventListener('keydown', handleKeyDown)
      }
    }
  }, [expandedLabel, setExpandedLabel])

  // Add effect to create a new chat on initial load
  useEffect(() => {
    if (isClient && !hasCreatedInitialChatRef.current) {
      hasCreatedInitialChatRef.current = true

      if (!storeHistory) {
        // For users without persistent storage, just clear the loading state
        setIsInitialLoad(false)
      } else if (chats.length === 0) {
        // Only create a new chat if there are no chats
        createNewChat()
      } else {
        setIsInitialLoad(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient]) // Only depend on isClient

  return {
    // State
    chats,
    currentChat,
    input,
    loadingState,
    retryInfo,
    inputRef,
    isClient,
    isSidebarOpen,
    isDarkMode,
    themeMode,
    isInitialLoad,
    isChatHydrating,
    isThinking,
    isWaitingForResponse,
    isStreaming,
    streamError,
    dismissStreamError,
    selectedModel,
    hasValidatedModel,
    expandedLabel,
    windowWidth,
    codeExecutionEncryptionKey,

    // Setters
    setInput,
    setIsSidebarOpen,
    setIsInitialLoad,
    setChats,
    setCurrentChat,

    // Actions
    handleSubmit,
    handleQuery,
    createNewChat,
    deleteChat,
    handleChatSelect,
    loadChatById,
    toggleTheme,
    setThemeMode,
    openAndExpandVerifier,
    handleInputFocus,
    handleLabelClick,
    handleModelSelect,
    cancelGeneration,
    updateChatTitle,
    reloadChats,
    editMessage,
    deleteMessage,
    editAssistantMessage,
    continueAssistantMessage,
    regenerateMessage,
    retryLastMessage,
    resolveInputToolCall,
    retryToolCall,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
    initialChatLoadFailed,
    cloudChatNotFound,
    retryInitialChatLoad,
  }
}
