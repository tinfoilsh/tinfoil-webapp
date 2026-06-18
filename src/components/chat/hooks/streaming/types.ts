/**
 * Canonical event vocabulary for the streaming pipeline.
 *
 * Every module downstream of the event-normalizer speaks this type.
 * The main loop switches on `event.type` — no format sniffing needed.
 */

import type { Chat, Message } from '../../types'

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

export type ThinkingStartEvent = { type: 'thinking_start' }
export type ThinkingDeltaEvent = { type: 'thinking_delta'; content: string }
export type ThinkingEndEvent = { type: 'thinking_end' }
/**
 * A late fragment of an already-closed thinking block. Upstream reasoning
 * parsers split the think-close boundary so the final reasoning fragment
 * can arrive after the first content deltas; it belongs at the end of the
 * previous thinking block, not in a new one.
 */
export type ThinkingTailDeltaEvent = {
  type: 'thinking_tail_delta'
  content: string
}
export type ContentDeltaEvent = { type: 'content_delta'; content: string }

export type WebSearchEvent = {
  type: 'web_search'
  id?: string
  status: 'in_progress' | 'completed' | 'failed' | 'blocked'
  query?: string
  sources?: Array<{ url: string; title?: string }>
  reason?: string
}

export type URLFetchEvent = {
  type: 'url_fetch'
  id: string
  url: string
  status: 'in_progress' | 'completed' | 'failed' | 'blocked'
}

export type AnnotationEvent = {
  type: 'annotation'
  url: string
  title: string
}

export type SearchReasoningEvent = {
  type: 'search_reasoning'
  content: string
}

// GenUI: model emits standard OpenAI tool_calls deltas. We split them into
// a `start` event (id + name) and `delta` events (accumulating JSON args).
export type GenUIToolCallStartEvent = {
  type: 'genui_tool_call_start'
  id: string
  name: string
}

export type GenUIToolCallDeltaEvent = {
  type: 'genui_tool_call_delta'
  id: string
  argumentsDelta: string
}

// Code execution: router emits `<tinfoil-event>` markers with a single
// `in_progress` event carrying fully-formed args, then a terminal event
// carrying the output. No mid-stream argument accumulation — args arrive
// fully-formed because the model finished emitting them before the router
// decided to run the tool.
export type CodeExecToolCallEvent = {
  type: 'code_exec_tool_call'
  id: string
  toolName: string
  status: 'in_progress' | 'completed' | 'failed' | 'blocked'
  arguments?: Record<string, unknown>
  output?: string
}

export type NormalizedEvent =
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ThinkingTailDeltaEvent
  | ContentDeltaEvent
  | WebSearchEvent
  | URLFetchEvent
  | AnnotationEvent
  | SearchReasoningEvent
  | GenUIToolCallStartEvent
  | GenUIToolCallDeltaEvent
  | CodeExecToolCallEvent

// ---------------------------------------------------------------------------
// Context passed by callers (unchanged from the old processor)
// ---------------------------------------------------------------------------

export interface StreamingContext {
  updatedChat: Chat
  updatedMessages: Message[]
  isFirstMessage: boolean
  modelsLength: number
  // Tracks the id of the chat this specific stream writes to. Created per
  // `handleQuery` call so concurrent streams never clobber each other, and
  // updated in place if the backend swaps the id mid-flight.
  streamChatIdRef: React.MutableRefObject<string>
  thinkingStartTimeRef: React.MutableRefObject<number | null>
  setIsThinking: (val: boolean) => void
  setIsWaitingForResponse: (val: boolean) => void
  setIsStreaming: (val: boolean) => void
  updateChatWithHistoryCheck: (
    setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
    chatSnapshot: Chat,
    setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>,
    chatId: string,
    newMessages: Message[],
    skipCloudSync?: boolean,
    skipIndexedDBSave?: boolean,
  ) => void
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>
  setLoadingState: (s: 'idle' | 'loading') => void
  storeHistory: boolean
  startingChatId: string
}

export interface StreamingHandlers {
  onAssistantMessageReady: (
    assistantMessage: Message,
    finalMessages: Message[],
  ) => Promise<void>
}
