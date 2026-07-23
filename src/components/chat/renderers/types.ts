import type { Attachment, LoadingState, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type { JSX } from 'react'

// ProcessedDocument type for chat input documents
export type ProcessedDocument = {
  id: string
  name: string
  time: Date
  content?: string
  isUploading?: boolean
  isUnsupported?: boolean
  attachment?: Attachment // The resolved attachment for this document
  isImageDescription?: boolean // True if content is from multimodal image description
  hasDescription?: boolean // True if a multimodal description has been generated
  isGeneratingDescription?: boolean // True while generating image description
  // Legacy field — kept for backward compat during transition
  imageData?: { base64: string; mimeType: string }
}

export interface MessageRenderProps {
  message: Message
  messageIndex: number
  model: BaseModel
  isDarkMode: boolean
  isLastMessage?: boolean
  isStreaming?: boolean
  hideActions?: boolean
  onEditMessage?: (messageIndex: number, newContent: string) => void
  onRegenerateMessage?: (messageIndex: number) => void
}

export interface InputRenderProps {
  onSubmit: (content: Message['content'], attachments?: Attachment[]) => void
  isDarkMode: boolean
  isPremium: boolean
  model: BaseModel
  input: string
  setInput: (value: string) => void
  loadingState: LoadingState
  cancelGeneration: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  handleInputFocus: () => void
  handleDocumentUpload?: (file: File) => Promise<void>
  processedDocuments?: ProcessedDocument[]
  removeDocument?: (id: string) => void
  hasMessages?: boolean
  webSearchEnabled?: boolean
  onWebSearchToggle?: () => void
  codeExecutionEnabled?: boolean
  onCodeExecutionToggle?: () => void
}

export interface MessageRenderer {
  id: string
  canRender: (message: Message, model: BaseModel) => boolean
  render: (props: MessageRenderProps) => JSX.Element
}

export interface InputRenderer {
  id: string
  canRender: (model: BaseModel) => boolean
  render: (props: InputRenderProps) => JSX.Element
}

export interface UIProvider {
  id: string
  modelPattern: RegExp
  messageRenderer: MessageRenderer
  inputRenderer: InputRenderer
  features?: {
    thoughts?: boolean
    documents?: boolean
    streaming?: boolean
    multimodal?: boolean
  }
}
