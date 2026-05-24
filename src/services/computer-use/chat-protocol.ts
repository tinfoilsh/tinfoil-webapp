/**
 * Minimal OpenAI-compatible chat-completions shapes the computer-use loop works
 * in. The loop runs *inside* a single user turn (the model drives the guest
 * over many model↔driver round-trips), so it speaks the raw chat protocol
 * directly rather than the webapp's `Message` type — that keeps the controller
 * isolated from the main chat pipeline and lets it carry `tool` messages and
 * image content parts, which the `Message` type doesn't model.
 *
 * These are intentionally a small structural subset, not the full SDK types, so
 * the loop has no compile-time dependency on the inference SDK and is trivial to
 * fake in tests.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

export type MessagePart = TextPart | ImageUrlPart
export type MessageContent = string | MessagePart[]

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: MessageContent | null
  /** Present on assistant messages that emit tool calls. */
  tool_calls?: ToolCall[]
  /** Present on `role: 'tool'` messages — links the result to its call. */
  tool_call_id?: string
}

/** OpenAI `tools[]` entry. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// -- streaming chunk subset --------------------------------------------------

export interface ToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export interface ChunkDelta {
  role?: string
  content?: string | null
  /**
   * Reasoning-model thinking, separate from `content`. Kimi K2.6 emits this
   * (field name `reasoning`; some servings use `reasoning_content`). Captured
   * for the audit trail; not fed back into the request for now.
   */
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: ToolCallDelta[]
}

export interface ChunkChoice {
  delta?: ChunkDelta
  finish_reason?: string | null
}

export interface ChatChunk {
  choices?: ChunkChoice[]
}

/**
 * The inference seam the loop depends on: stream a chat completion as an async
 * iterable of chunks. The production implementation wraps the attested
 * `SecureClient` (`getTinfoilClient`); tests inject a fake that yields scripted
 * chunks. Keeping this an interface is what makes the multi-turn loop unit-
 * testable without the network or a booted enclave.
 */
export interface StreamChatParams {
  messages: ChatMessage[]
  tools: ToolSchema[]
  signal?: AbortSignal
}

export type StreamChat = (
  params: StreamChatParams,
) => AsyncIterable<ChatChunk> | Promise<AsyncIterable<ChatChunk>>

/** Build a `data:` URL for an image content part from base64 + mime type. */
export function dataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`
}
