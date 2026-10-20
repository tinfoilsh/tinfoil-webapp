import type { DocumentPage } from '@/components/chat/types'

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
  // The quota after the request, which an exhausted quota's refusal reports.
  rateLimit?: RateLimit
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
  activity?: ToolActivity
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

export interface ThreadMessage extends Omit<Message, 'attachments'> {
  attachments?: AttachmentDescriptor[]
  annotations?: Json
}

// A whole chat in the format the harness stores it in sync, a chat on this
// device is kept in, and a device run's final event returns.
export interface StoredThread {
  id: string
  title: string
  titleState: ThreadSummary['titleState']
  createdAt: string
  updatedAt: string
  model: string
  projectId: string | null
  presetId: string | null
  pinned: boolean
  webSearchEnabled: boolean
  messages: ThreadMessage[]
  lastRequestId?: string
  activeRun: ThreadSummary['activeRun']
  contextUsage?: ThreadSummary['contextUsage']
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
  // The value of every profile field a profile leaves unset.
  profileDefaults: RecordValue
  presets: {
    id: string
    name: string
    description?: string
    icon?: string
    systemPrompt?: string
    builtIn: boolean
  }[]
  features: Record<string, boolean>
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
  thread?: StoredThread
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

// Re-attaches to a live run, which replays it from its first frame.
export interface FollowInput {
  key?: string
  threadId: string
  runId: string
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

// The state changes a run sends: its queue, and the title the harness
// names a new chat with.
export type StatePatch =
  | { op: 'add'; path: '/queue/-'; value: QueueItem }
  | { op: 'replace'; path: '/queue'; value: QueueItem[] }
  | { op: 'replace'; path: '/thread/title'; value: string }
  | {
      op: 'replace'
      path: '/thread/titleState'
      value: ThreadSummary['titleState']
    }

// A tool's output as it runs: its progress, and the lines it printed.
export interface ToolActivity {
  toolCallId?: string
  tool?: string
  progress?: number
  output: Json[]
}
export type ActivityPatch =
  | { op: 'replace'; path: '/progress'; value: number }
  | { op: 'add'; path: '/output/-'; value: Json }

// What a run's final event reports. A device chat's run returns the whole
// thread.
export interface RunMetadata {
  cancelled?: boolean
  rateLimit?: RateLimit
  usage?: Json
  thread?: unknown
}

interface RunError {
  code?: string
  message?: string
  kind?: string
  resetsAt?: string
  retryAfter?: number
}

// The events of a run's stream, as the harness emits them.
export type HarnessEvent = { timestamp?: string } & (
  | {
      type: 'RUN_STARTED'
      threadId?: string
      runId: string
      // The reply a continuation streams into.
      messageId?: string
      queued?: boolean
    }
  | { type: 'MESSAGES_SNAPSHOT'; messages: Message[]; hasOlder?: boolean }
  | { type: 'STATE_SNAPSHOT'; snapshot: Snapshot }
  | {
      type: 'STATE_DELTA'
      threadId?: string
      // Set for a turn queued behind the running reply.
      runId?: string
      delta: StatePatch[]
    }
  | {
      type: 'TEXT_MESSAGE_CHUNK'
      messageId: string
      role?: 'assistant'
      delta: string
    }
  | { type: 'REASONING_MESSAGE_CHUNK'; messageId: string; delta: string }
  | {
      type: 'TOOL_CALL_START'
      toolCallId: string
      toolCallName: string
      parentMessageId?: string
    }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | {
      type: 'TOOL_CALL_RESULT'
      toolCallId: string
      messageId?: string
      role?: 'tool'
      content?: Json
      metadata?: RecordValue
    }
  | {
      type: 'ACTIVITY_SNAPSHOT'
      messageId: string
      activityType?: string
      content: ToolActivity
    }
  | {
      type: 'ACTIVITY_DELTA'
      messageId: string
      activityType?: string
      patch: ActivityPatch[]
    }
  | {
      type: 'RUN_FINISHED'
      threadId?: string
      runId?: string
      metadata?: RunMetadata
    }
  | ({
      type: 'RUN_ERROR'
      threadId?: string
      runId?: string
      metadata?: RunMetadata
    } & RunError)
)

export type TerminalEvent = Extract<
  HarnessEvent,
  { type: 'RUN_FINISHED' | 'RUN_ERROR' }
>

export interface Frame {
  event: HarnessEvent
  id?: number
}

export interface SharedThread {
  title: string
  createdAt: string
  messages: Message[]
}
