import { selectPendingInputToolCall } from '@/components/chat/genui/pending-input-tool-call'
import type { GenUIWidget } from '@/components/chat/genui/types'
import type { Message } from '@/components/chat/types'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The selector consults the registry to identify input-surface widgets;
// stub it before importing anything that depends on it.
vi.mock('@/components/chat/genui/registry', () => {
  const input: Partial<GenUIWidget> = {
    name: 'ask_user_input',
    surface: 'input',
    renderInputArea: () => null,
    schema: {
      safeParse: (value: unknown) => {
        const valid =
          !!value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'question' in value &&
          typeof value.question === 'string' &&
          'options' in value &&
          Array.isArray(value.options) &&
          value.options.length >= 2
        return valid
          ? { success: true, data: value }
          : { success: false, error: {} }
      },
    } as any,
  }
  const inline: Partial<GenUIWidget> = {
    name: 'render_callout',
    surface: 'inline',
  }
  return {
    GENUI_WIDGETS_BY_NAME: {
      ask_user_input: input,
      render_callout: inline,
    },
  }
})

function assistantMessage(
  blocks: Array<{
    type: 'tool_call' | 'content'
    id: string
    name?: string
    toolCallId?: string
    args?: string
    resolvedAt?: number
    content?: string
  }>,
): Message {
  return {
    id: 'm',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    timeline: blocks.map((b) => {
      if (b.type === 'tool_call') {
        return {
          type: 'tool_call' as const,
          id: b.id,
          name: b.name ?? '',
          toolCallId: b.toolCallId ?? b.id,
          arguments: b.args ?? '',
          resolvedAt: b.resolvedAt,
        }
      }
      return {
        type: 'content' as const,
        id: b.id,
        content: b.content ?? '',
      }
    }),
  }
}

describe('selectPendingInputToolCall', () => {
  beforeAll(() => {})

  it('returns null when there are no messages', () => {
    expect(selectPendingInputToolCall([])).toBeNull()
  })

  it('returns null for inline-surface tool calls', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'render_callout',
          toolCallId: 't1',
          args: '{}',
        },
      ]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })

  it('finds an unresolved input-surface tool call on the last assistant message', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 't1',
          args: '{"question":"Pick one","options":[{"label":"A"},{"label":"B"}]}',
        },
      ]),
    ]
    const result = selectPendingInputToolCall(msgs)
    expect(result).toMatchObject({
      toolCallId: 't1',
      name: 'ask_user_input',
    })
    expect(result?.args).toEqual({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }],
    })
  })

  it('returns null for malformed input tool arguments', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 't1',
          args: '{"question":"Pick one"',
        },
      ]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })

  it('returns null for schema-invalid input tool arguments', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 't1',
          args: '{"question":"Pick one"}',
        },
      ]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })

  it('skips already-resolved input tool calls', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 't1',
          args: '{}',
          resolvedAt: 1,
        },
      ]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })

  it('only inspects the LAST assistant message', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 'old',
          args: '{}',
        },
      ]),
      {
        id: 'u',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      },
      assistantMessage([{ type: 'content', id: 'c1', content: 'hi' }]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })
})
