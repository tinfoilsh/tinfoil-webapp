export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }
export type RecordValue = { [key: string]: Json }

export interface HarnessErrorBody {
  code: string
  message: string
  kind?: string
  retryAfter?: number
  resetsAt?: string
  keyId?: string
}

export interface Attachment {
  id: string
  kind: string
  fileName: string
  mimeType: string
  size: number
  thumbnail?: string | null
  textContent?: string
  attKey?: string
  pages?: number | null
  status: string
}

export interface TimelineBlock {
  id: string
  type: 'content' | 'thinking' | 'tool_call'
  content?: string
  toolCallId?: string
  name?: string
  arguments?: string
  complete?: boolean
  result?: Json
  metadata?: Json
  progress?: Json[]
  activity?: Json
  resolvedAt?: string | number | null
  resolution?: { text: string; data?: Json } | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  content?: string
  quote?: string
  model?: string
  modelDisplayName?: string
  timeline?: TimelineBlock[]
  attachments?: Attachment[]
  isError?: boolean
  isInterrupted?: boolean
}

export interface ThreadSummary {
  contextUsage?: {
    usedTokens: number
    limitTokens: number
    percentage: number
  } | null
  id: string
  title: string
  titleState: 'placeholder' | 'generated' | 'manual'
  createdAt: string
  updatedAt: string
  model: string
  projectId: string | null
  pinned: boolean
  webSearchEnabled: boolean
  messageCount: number
  activeRun: { runId: string; lastEventId: number } | null
}

export interface Thread extends ThreadSummary {
  messages: Message[]
  hasOlder: boolean
  revision?: string
  presetId?: string | null
}

export interface RateLimit {
  kind: string | null
  maxRequests: number
  remaining: number
  resetsAt?: string
}

export interface Session {
  user: { id: string; anonymous: boolean }
  rateLimit: RateLimit
  key: {
    registered: boolean
    keyId: string | null
    bundles: { credentialId: string; createdAt: string }[]
  }
  models: {
    id: string
    name: string
    nameShort?: string
    description?: string
    image?: string
    paid?: boolean
    experimental?: boolean
    deprecationDate?: string
    descriptionShort?: string
    attributes?: string[]
    deprecated?: boolean
    multimodal: boolean
    reasoning: {
      toggle: boolean
      effort: boolean
      defaultEnabled: boolean
    } | null
  }[]
  auto: {
    multimodal: boolean
    default: string
    levels: { id: string; label: string }[]
  } | null
  defaultModel: string
  widgets: string[]
  presets: {
    id: string
    name: string
    description?: string
    icon?: string
    systemPrompt?: string
    builtIn: boolean
  }[]
  features: Record<string, boolean>
  upload: { accept: string[]; maxBytes: number; maxTextBytes: number }
}

export interface Turn {
  key?: string
  clientRequestId: string
  threadId: string | null
  kind: 'send' | 'edit' | 'regenerate' | 'resolve' | 'retryToolCall' | 'ask'
  ephemeral?: boolean
  projectId?: string | null
  presetId?: string | null
  content?: string
  quote?: string
  messageId?: string
  toolCallId?: string
  resolution?: { text: string; data?: Json }
  attachments?: string[]
  widgets?: string[]
  options?: {
    model?: string
    autoIntelligence?: string
    timezone?: string
    reasoningEffort?: string
    thinking?: boolean
    webSearch?: boolean
    codeExecution?: boolean
    genUI?: boolean
    piiCheck?: boolean
  }
}

export interface QueueItem {
  queueId: string
  content: string
  kind?: string
}
export interface Snapshot {
  thread: ThreadSummary | null
  queue: QueueItem[]
  rateLimit?: RateLimit
}
export interface Patch {
  op: 'add' | 'replace' | 'remove' | 'test' | 'move' | 'copy'
  path: string
  value?: Json
  from?: string
}

export interface HarnessEvent {
  type: string
  timestamp?: string
  threadId?: string
  runId?: string
  messageId?: string
  parentMessageId?: string
  toolCallId?: string
  toolCallName?: string
  delta?: string | Patch[]
  snapshot?: Snapshot
  messages?: Message[]
  hasOlder?: boolean
  content?: Json
  metadata?: RecordValue
  patch?: Patch[]
  code?: string
  message?: string
  retryAfter?: number
}

export interface Frame {
  event: HarnessEvent
  id?: number
}

export interface SharedThread {
  title: string
  createdAt: string
  messages: Message[]
}
