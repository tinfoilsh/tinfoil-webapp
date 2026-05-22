/**
 * Collect one streamed assistant turn from an OpenAI-compatible chunk stream
 * into its final content + tool calls. The computer-use loop runs many of these
 * back-to-back; each turn is either the model emitting action tool calls (drive
 * the guest, feed results, loop) or plain content (the model is done / talking
 * to the user).
 *
 * Tool-call deltas arrive keyed by `index` with the `id`/`name` on the first
 * delta and `arguments` accumulating across deltas — the same shape the chat
 * pipeline's event-normalizer handles; we accumulate to whole calls here since
 * the loop only acts once a turn completes.
 */

import type { ChatChunk, ToolCall } from './chat-protocol'

export interface CollectedTurn {
  content: string
  /** Reasoning-model thinking (Kimi `reasoning`), accumulated for the audit trail. */
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

interface PartialCall {
  id: string
  name: string
  arguments: string
}

export async function collectTurn(
  stream: AsyncIterable<ChatChunk>,
  signal?: AbortSignal,
): Promise<CollectedTurn> {
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  // Keyed by tool_call index, preserving emission order.
  const byIndex = new Map<number, PartialCall>()

  for await (const chunk of stream) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta

    if (typeof delta?.content === 'string') {
      content += delta.content
    }
    const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content
    if (typeof reasoningDelta === 'string') {
      reasoning += reasoningDelta
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (typeof tc.index !== 'number') continue
        const existing = byIndex.get(tc.index) ?? {
          id: '',
          name: '',
          arguments: '',
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') {
          existing.arguments += tc.function.arguments
        }
        byIndex.set(tc.index, existing)
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const toolCalls: ToolCall[] = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id || `call_${index}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments },
    }))
    .filter((c) => c.function.name !== '')

  return { content, reasoning, toolCalls, finishReason }
}
