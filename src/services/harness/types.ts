import type { DocumentPage } from '@/components/chat/types'
import type { LocalTurnThread } from './local-threads'

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
  // The status a downstream service answered with, when the harness maps it.
  status?: number
  // A document conversion failure's document_* code.
  upstreamCode?: string
}

export interface Attachment {
  id: string
  kind: string
  fileName: string
  mimeType: string
  size: number
  thumbnail?: string | null
  textContent?: string
  description?: string
  attKey?: string
  pages?: number | null
  status?: string
}

// An attachment as an upload returns it and a turn sends it. The harness
// keeps nothing of an upload, so a turn carries an image's bytes.
export interface AttachmentDescriptor {
  id: string
  kind: string
  fileName: string
  mimeType: string
  size: number
  thumbnail?: string | null
  textContent?: string
  description?: string
  pages?: DocumentPage[]
  base64?: string
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
  usage?: Json
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
  // A hint that a run may be live, set when it starts and cleared when it
  // commits. It never blocks an action.
  activeRun: { runId: string; expiresAt: string } | null
}

export interface Thread extends ThreadSummary {
  messages: Message[]
  hasOlder: boolean
  revision?: string
  presetId?: string | null
}

// One dimension (input or output) of a token budget.
export interface TokenBudget {
  max: number
  used: number
  remaining: number
}

// A free key's daily request quota (free_daily), or a subscriber's hourly
// token budgets (hourly), which have a request quota only once capped.
export interface RateLimit {
  kind: 'free_daily' | 'hourly' | null
  maxRequests?: number
  remaining?: number
  resetsAt?: string
  inputTokens?: TokenBudget
  outputTokens?: TokenBudget
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
  kind:
    | 'send'
    | 'edit'
    | 'regenerate'
    | 'continue'
    | 'resolve'
    | 'retryToolCall'
    | 'ask'
  ephemeral?: boolean
  local?: boolean
  thread?: LocalTurnThread
  profile?: RecordValue
  projectId?: string | null
  presetId?: string | null
  content?: string
  quote?: string
  messageId?: string
  toolCallId?: string
  resolution?: { text: string; data?: Json }
  // New uploads, or an attachment the stored chat has, by id.
  attachments?: (AttachmentDescriptor | { id: string })[]
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
  kind?: string
  resetsAt?: string
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
