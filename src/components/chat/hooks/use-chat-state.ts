import type { BaseModel } from '@/config/models'
import { useEffect, useRef } from 'react'
import type { AIModel, Chat, LabelType, LoadingState, Message } from '../types'
import { useChatMessaging } from './use-chat-messaging'
import { useChatStorage } from './use-chat-storage'
import { useModelManagement } from './use-model-management'
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
  inputRef: React.RefObject<HTMLTextAreaElement>
  isClient: boolean
  isSidebarOpen: boolean
  isDarkMode: boolean
  themeMode: ThemeMode
  messagesEndRef: React.RefObject<HTMLDivElement>
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

  // Setters
  setInput: (input: string) => void
  setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  setIsInitialLoad: (isLoading: boolean) => void
  setVerificationComplete: (complete: boolean) => void
  setVerificationSuccess: (success: boolean) => void

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
  cancelGeneration: () => Promise<void>
  updateChatTitle: (chatId: string, newTitle: string) => void
  reloadChats: () => Promise<void>
  editMessage: (messageIndex: number, newContent: string) => void
  regenerateMessage: (messageIndex: number) => void
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
  piiCheckEnabled,
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
  piiCheckEnabled?: boolean
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
    beforeSwitchChat: async () => {
      // Cancel generation will be defined after useChatMessaging hook
      if (cancelGenerationRef.current) {
        await cancelGenerationRef.current()
      }
    },
    initialChatId,
    isLocalChatUrl,
  })

  // Create ref to store cancelGeneration function
  const cancelGenerationRef = useRef<(() => Promise<void>) | null>(null)

  // Model Management
  const {
    selectedModel,
    hasValidatedModel,
    expandedLabel,
    setExpandedLabel,
    setVerificationComplete,
    setVerificationSuccess,
    verificationComplete,
    verificationSuccess,
    handleModelSelect,
    handleLabelClick,
  } = useModelManagement({
    models,
    isClient,
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
    piiCheckEnabled,
  })

  // Update ref with cancelGeneration function
  cancelGenerationRef.current = cancelGeneration

  // Add effect to handle clicks outside the model/reasoning selectors
  useEffect(() => {
    if (expandedLabel === 'model' || expandedLabel === 'reasoning') {
      const handleClickOutside = (event: MouseEvent) => {
        if (expandedLabel === 'model') {
          const modelSelectorButton = document.querySelector(
            '[data-model-selector]',
          )
          const modelSelectorMenu = document.querySelector('[data-model-menu]')

          if (
            modelSelectorButton &&
            modelSelectorMenu &&
            !modelSelectorButton.contains(event.target as Node) &&
            !modelSelectorMenu.contains(event.target as Node)
          ) {
            setExpandedLabel(null)
          }
        } else if (expandedLabel === 'reasoning') {
          const reasoningSelectorButton = document.querySelector(
            '[data-reasoning-selector]',
          )
          const reasoningSelectorMenu = document.querySelector(
            '[data-reasoning-menu]',
          )

          if (
            reasoningSelectorButton &&
            reasoningSelectorMenu &&
            !reasoningSelectorButton.contains(event.target as Node) &&
            !reasoningSelectorMenu.contains(event.target as Node)
          ) {
            setExpandedLabel(null)
          }
        }
      }

      document.addEventListener('mousedown', handleClickOutside)

      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
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
        // Just ensure loading state is cleared
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

    // Setters
    setInput,
    setIsSidebarOpen,
    setIsInitialLoad,
    setVerificationComplete,
    setVerificationSuccess,

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
    resolveInputToolCall,
    initialChatDecryptionFailed,
    clearInitialChatDecryptionFailed,
    localChatNotFound,
  }
}
