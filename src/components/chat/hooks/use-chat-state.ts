import { isModelNameAvailable, type BaseModel } from '@/config/models'
import { useExecSnapshot } from '@/services/exec-snapshot/use-exec-snapshot'
import { logWarning } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AIModel, Chat, LabelType, LoadingState, Message } from '../types'
import { useChatMessaging } from './use-chat-messaging'
import { useChatStorage } from './use-chat-storage'
import { resolveChatModel, useModelManagement } from './use-model-management'
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  isInitialLoad: boolean
  isThinking: boolean
  verificationComplete: boolean
  verificationSuccess: boolean
  isWaitingForResponse: boolean
  isStreaming: boolean
  streamError: string | null
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
  setVerificationComplete: (complete: boolean) => void
  setVerificationSuccess: (success: boolean) => void
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
  ) => void
  createNewChat: (isLocalOnly?: boolean, fromUserAction?: boolean) => void
  deleteChat: (chatId: string) => void
  handleChatSelect: (chatId: string) => void
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
  regenerateMessage: (messageIndex: number) => void
  retryLastMessage: () => void
  resolveInputToolCall: (
    toolCallId: string,
    resultText: string,
    resultData?: unknown,
  ) => void
  initialChatDecryptionFailed: boolean
  clearInitialChatDecryptionFailed: () => void
  localChatNotFound: boolean
}

export function useChatState({
  systemPrompt,
  rules = '',
  storeHistory = true,
  models = [],
  scrollToBottom,
  reasoningEffort,
  thinkingEnabled,
  initialChatId,
  isLocalChatUrl = false,
  webSearchEnabled,
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
  initialChatId?: string | null
  isLocalChatUrl?: boolean
  webSearchEnabled?: boolean
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
    messagesEndRef,
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
    setIsInitialLoad,
    isInitialLoad,
    reloadChats,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
  } = useChatStorage({
    storeHistory,
    scrollToBottom,
    initialChatId,
    isLocalChatUrl,
  })

  // Model Management - the hook owns model validation and the label/
  // verification UI state. The active model itself is per-chat: it is
  // resolved from the current chat (falling back to the first available
  // model) so concurrent chats never override each other.
  const {
    hasValidatedModel,
    expandedLabel,
    setExpandedLabel,
    setVerificationComplete,
    setVerificationSuccess,
    verificationComplete,
    verificationSuccess,
    handleLabelClick,
  } = useModelManagement({
    models,
    isClient,
  })

  const selectedModel = useMemo(
    () => resolveChatModel(currentChat, models),
    [currentChat, models],
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
      setExpandedLabel(null)
    },
    [models, updateChatModel, setExpandedLabel],
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
    regenerateMessage,
    retryLastMessage,
    resolveInputToolCall,
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
    messagesEndRef,
    scrollToBottom,
    reasoningEffort,
    thinkingEnabled,
    webSearchEnabled,
    // code-exec requires encryptionKey for snapshots
    codeExecutionEnabled:
      codeExecutionEnabled && codeExecutionEncryptionKey != null,
    piiCheckEnabled,
    genUIEnabled,
    codeExecutionEncryptionKey,
  })

  // Add effect to handle dismissing the model/reasoning selectors
  useEffect(() => {
    if (expandedLabel === 'model' || expandedLabel === 'reasoning') {
      const triggerSelector =
        expandedLabel === 'model'
          ? '[data-model-selector]'
          : '[data-reasoning-selector]'
      const menuSelector =
        expandedLabel === 'model'
          ? '[data-model-menu]'
          : '[data-reasoning-menu]'

      const getSelectorElements = () => ({
        trigger: document.querySelector<HTMLElement>(triggerSelector),
        menu: document.querySelector<HTMLElement>(menuSelector),
      })

      const isOutsideSelector = (target: EventTarget | null) => {
        if (!(target instanceof Node)) return false
        const { trigger, menu } = getSelectorElements()
        return (
          trigger && menu && !trigger.contains(target) && !menu.contains(target)
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
          getSelectorElements().trigger?.focus()
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
    messagesEndRef,
    isInitialLoad,
    isThinking,
    verificationComplete,
    verificationSuccess,
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
    setVerificationComplete,
    setVerificationSuccess,
    setChats,
    setCurrentChat,

    // Actions
    handleSubmit,
    handleQuery,
    createNewChat,
    deleteChat,
    handleChatSelect,
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
    regenerateMessage,
    retryLastMessage,
    resolveInputToolCall,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
  }
}
