/**
 * Selector for the currently pending input-surface tool call.
 *
 * The chat input takes over when the latest assistant message contains an
 * unresolved `tool_call` timeline block whose widget has `surface: 'input'`.
 * This module encapsulates the selection logic so both the hook layer and
 * tests can share the same rule.
 */
import type { Chat, Message, TimelineToolCallBlock } from '../types'
import { GENUI_WIDGETS_BY_NAME } from './registry'

export interface PendingInputToolCall {
  messageIndex: number
  blockId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
}

function parseArgs(argsString: string): Record<string, unknown> | null {
  if (!argsString) return null
  try {
    const parsed = JSON.parse(argsString)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Arguments still streaming or malformed
  }
  return null
}

function parseRenderableInputArgs(
  name: string,
  argsString: string,
): Record<string, unknown> | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (widget?.surface !== 'input' || !widget.renderInputArea) return null

  const args = parseArgs(argsString)
  if (!args) return null

  const parsed = widget.schema.safeParse(args)
  if (
    !parsed.success ||
    !parsed.data ||
    typeof parsed.data !== 'object' ||
    Array.isArray(parsed.data)
  ) {
    return null
  }
  return parsed.data as Record<string, unknown>
}

/**
 * Find the pending input-surface tool call on the last assistant message of
 * a chat, or null if there isn't one.
 *
 * The search walks the last assistant message's timeline backwards and
 * returns the first unresolved `tool_call` block whose widget has
 * `surface: 'input'`. "Unresolved" means `resolvedAt` is not set.
 */
export function selectPendingInputToolCall(
  messages: Message[],
): PendingInputToolCall | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    if (!msg.timeline) return null

    for (let j = msg.timeline.length - 1; j >= 0; j--) {
      const block = msg.timeline[j]
      if (block.type !== 'tool_call') continue
      if ((block as TimelineToolCallBlock).resolvedAt) continue
      const args = parseRenderableInputArgs(block.name, block.arguments)
      if (!args) continue

      return {
        messageIndex: i,
        blockId: block.id,
        toolCallId: block.toolCallId,
        name: block.name,
        args,
      }
    }
    // Only the LAST assistant message is considered — stop here.
    return null
  }
  return null
}

export function selectPendingInputToolCallFromChat(
  chat: Chat | undefined | null,
): PendingInputToolCall | null {
  if (!chat) return null
  return selectPendingInputToolCall(chat.messages)
}
