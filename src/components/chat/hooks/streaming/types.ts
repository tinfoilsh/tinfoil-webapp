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

export type ToolCallStartEvent = {
  type: 'tool_call_start'
  id: string
  name: string
}

export type ToolCallDeltaEvent = {
  type: 'tool_call_delta'
  id: string
  argumentsDelta: string
}

export type NormalizedEvent =
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ContentDeltaEvent
  | WebSearchEvent
  | URLFetchEvent
  | AnnotationEvent
  | SearchReasoningEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent

// ---------------------------------------------------------------------------
// Context passed by callers (unchanged from the old processor)
// ---------------------------------------------------------------------------

export interface StreamingContext {
  updatedChat: Chat
  updatedMessages: Message[]
  isFirstMessage: boolean
  modelsLength: number
  currentChatIdRef: React.MutableRefObject<string>
  isStreamingRef: React.MutableRefObject<boolean>
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
