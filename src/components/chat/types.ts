export type URLCitation = {
  title: string
  url: string
  start_index?: number
  end_index?: number
}

export type Annotation = {
  type: 'url_citation'
  url_citation: URLCitation
}

export type WebSearchSource = {
  title: string
  url: string
}

export type WebSearchState = {
  query?: string
  status: 'searching' | 'completed' | 'failed' | 'blocked'
  sources?: WebSearchSource[]
  reason?: string
}

export type WebSearchInstance = WebSearchState & {
  id: string
}

export type URLFetchState = {
  id: string
  url: string
  status: 'fetching' | 'completed' | 'failed'
}

export type TimelineThinkingBlock = {
  type: 'thinking'
  id: string
  content: string
  isThinking: boolean
  duration?: number
}

export type TimelineWebSearchBlock = {
  type: 'web_search'
  id: string
  state: WebSearchState
}

export type TimelineURLFetchBlock = {
  type: 'url_fetches'
  id: string
  fetches: URLFetchState[]
}

export type TimelineContentBlock = {
  type: 'content'
  id: string
  content: string
}

export type TimelineToolCallBlock = {
  type: 'tool_call'
  id: string
  toolCallId: string
  name: string
  // Accumulating JSON string from streamed argument deltas.
  arguments: string
  // Set once a `surface: 'input'` widget has been resolved by the user.
  resolvedAt?: number
  resolution?: {
    text: string
    data?: unknown
  }
}

export type TimelineBlock =
  | TimelineThinkingBlock
  | TimelineWebSearchBlock
  | TimelineURLFetchBlock
  | TimelineContentBlock
  | TimelineToolCallBlock

export type Attachment = {
  id: string
  type: 'image' | 'document'
  fileName: string
  mimeType?: string
  base64?: string
  thumbnailBase64?: string
  textContent?: string
  description?: string
  fileSize?: number
  // v1 format: per-attachment encryption key material (base64-encoded)
  encryptionKey?: string
}

export type Message = {
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  // Legacy fields — kept for reading old messages, not written for new ones
  documentContent?: string
  multimodalText?: string
  documents?: Array<{ name: string }>
  imageData?: Array<{ base64: string; mimeType: string }>
  timestamp: Date
  thoughts?: string
  isThinking?: boolean
  thinkingDuration?: number // Duration in seconds
  isError?: boolean
  isRateLimitError?: boolean
  urlFetches?: URLFetchState[]
  webSearch?: WebSearchState
  webSearchBeforeThinking?: boolean // True if web search started before thinking
  annotations?: Annotation[] // URL citations from web search
  searchReasoning?: string // Search agent's reasoning for multi-turn context
  quote?: string // Highlighted text the user is replying to
  timeline?: TimelineBlock[] // Chronological sequence of blocks for rendering
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
  }> // GenUI tool calls emitted by the model (derived from timeline)
}

export type TitleState = 'placeholder' | 'generated' | 'manual'

export type Chat = {
  id: string
  title: string
  titleState?: TitleState
  messages: Message[]
  createdAt: Date
  // Sync metadata - optional for backward compatibility
  syncedAt?: number
  locallyModified?: boolean
  decryptionFailed?: boolean
  // Blank chat flag - true for new chats that haven't been used yet
  isBlankChat?: boolean
  // Local-only flag - true for chats that should never sync to cloud
  isLocalOnly?: boolean
  // Pending save flag - true while initial save is in progress
  pendingSave?: boolean
  // Project association - when set, chat belongs to a project
  projectId?: string
}

export type LoadingState = 'idle' | 'loading' | 'streaming' | 'retrying'

export type AIModel = string

export type ModelInfo = {
  name: string
  nameShort: string
  description: string
  image: string
  endpoint?: string
}

export type LabelType = 'verify' | 'model' | 'info' | 'reasoning' | null

// Document processing types
export type DocumentProcessingStatus =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'error'

export interface DocumentMetadata {
  filename?: string
  size?: number
  type?: string
  lastModified?: number
}

export interface DocumentProcessingResult {
  document?: {
    md_content: string
    filename?: string
  } & DocumentMetadata
  status?: DocumentProcessingStatus
  error?: string
}

export interface DocumentUploadProps {
  onUploadStart: () => void
  onUploadComplete: (content: string) => void
  onUploadError: (error: Error) => void
  setIsUploading: (isUploading: boolean) => void
}
