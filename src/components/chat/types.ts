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
  snippet?: string
}

export type WebSearchState = {
  query?: string
  status: 'searching' | 'completed' | 'failed' | 'blocked'
  sources?: WebSearchSource[]
  reason?: string
}

export type URLFetchState = {
  id: string
  url: string
  status: 'fetching' | 'completed' | 'failed'
  sources?: WebSearchSource[]
}

// Wall-clock stamps (epoch ms) recorded while streaming so a running step
// can show how long it has run. Absent on legacy messages and on builders
// constructed without a clock.
export type TimelineTiming = {
  startedAt?: number
  endedAt?: number
}

export type TimelineThinkingBlock = TimelineTiming & {
  type: 'thinking'
  id: string
  content: string
  isThinking: boolean
  duration?: number
  // The chat service's live summary of the thinking while it goes on.
  summary?: string
}

export type TimelineWebSearchBlock = TimelineTiming & {
  type: 'web_search'
  id: string
  state: WebSearchState
}

export type TimelineURLFetchBlock = TimelineTiming & {
  type: 'url_fetches'
  id: string
  fetches: URLFetchState[]
}

export type TimelineContentBlock = {
  type: 'content'
  id: string
  content: string
}

// GenUI tool calls — one block per call. Arguments arrive as JSON-string
// deltas during streaming.
export type TimelineToolCallBlock = TimelineTiming & {
  type: 'tool_call'
  id: string
  toolCallId: string
  name: string
  // Accumulating JSON string from streamed argument deltas.
  arguments: string
  complete?: boolean
  result?: unknown
  metadata?: unknown
  progress?: unknown[]
  // The harness found the stored arguments no longer match the widget.
  invalidArguments?: boolean
}

export type TimelineBlock =
  | TimelineThinkingBlock
  | TimelineWebSearchBlock
  | TimelineURLFetchBlock
  | TimelineContentBlock
  | TimelineToolCallBlock

export type DocumentPage = {
  page: number
  text: string
  image: string
  is_scanned: boolean
}

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
  pages?: DocumentPage[]
  // v1 format: per-attachment encryption key material (base64-encoded)
  encryptionKey?: string
}

export type Message = {
  id?: string
  isInterrupted?: boolean
  role: 'user' | 'assistant'
  content: string
  turnId?: string
  modelDisplayName?: string
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
  isHourlyRateLimitError?: boolean
  urlFetches?: URLFetchState[]
  webSearch?: WebSearchState
  webSearchBeforeThinking?: boolean // True if web search started before thinking
  annotations?: Annotation[] // URL citations from web search
  searchReasoning?: string // Search agent's reasoning for multi-turn context
  quote?: string // Highlighted text the user is replying to
  timeline?: TimelineBlock[] // Chronological sequence of blocks for rendering
  // GenUI tool calls emitted by the model (derived from timeline)
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
  }>
}

export type TitleState = 'placeholder' | 'generated' | 'manual'

export type Chat = {
  activeRun?: { runId: string } | null
  // The safeguards flagged the chat: it is read-only.
  flagged?: boolean
  pinned?: boolean
  id: string
  title: string
  titleState?: TitleState
  messages: Message[]
  messageCount?: number
  isMetadataOnly?: boolean
  createdAt?: Date
  // Latest server-bumped write time, independent of conversation activity.
  updatedAt?: string
  activityAt?: string
  // Blank chat flag - true for new chats that haven't been used yet
  isBlankChat?: boolean
  // Local-only flag - true for chats that should never sync to cloud
  isLocalOnly?: boolean
  // Temporary flag - true for ephemeral chats that are never persisted anywhere
  isTemporary?: boolean
  // Pending save flag - true while initial save is in progress
  pendingSave?: boolean
  // Project association - when set, chat belongs to a project
  projectId?: string
  // Prompt library preset association - when set, this preset's system
  // prompt overrides the default for this chat.
  presetId?: string
  // Model this chat is associated with. Drives the selector when the chat
  // is active and the model used for new messages. Falls back to the first
  // available model when unset or no longer available.
  model?: string
  // Per-chat web search preference. When unset, falls back to the global
  // default. Persisted with the chat and synced across devices (the iOS
  // app reads/writes the same field).
  webSearchEnabled?: boolean
}

export type LoadingState = 'idle' | 'loading' | 'streaming' | 'retrying'

export type QueuedMessage = {
  id: string
  text: string
  attachments?: Attachment[]
  quote?: string
}

export type AIModel = string

export type ModelInfo = {
  name: string
  nameShort: string
  description: string
  image: string
  endpoint?: string
}

export type LabelType = 'verify' | 'model' | 'info' | null

// Document processing types
export type DocumentProcessingStatus =
  'idle' | 'uploading' | 'processing' | 'complete' | 'error'

export interface DocumentMetadata {
  filename?: string
  size?: number
  type?: string
  lastModified?: number
}

export interface DocumentProcessingResult {
  document?: {
    md_content: string
    pages?: DocumentPage[]
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
