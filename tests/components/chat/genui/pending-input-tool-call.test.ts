import type { GenUIWidget } from '@/components/chat/genui/types'
import type { Message } from '@/components/chat/types'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const { registryMock } = vi.hoisted(() => ({
  registryMock: async () => {
    const { z } = await import('zod')
    const MIN_INPUT_OPTIONS = 2
    const schema = z
      .object({
        question: z.string(),
        options: z
          .array(z.object({ label: z.string() }).strict())
          .min(MIN_INPUT_OPTIONS),
      })
      .strict()
    const input: GenUIWidget = {
      name: 'ask_user_input',
      description: 'Synthetic input widget for selector contracts',
      surface: 'input',
      renderInputArea: () => null,
      schema,
    }
    const inline: GenUIWidget = {
      ...input,
      name: 'render_callout',
      surface: 'inline',
    }
    return {
      GENUI_WIDGETS_BY_NAME: {
        ask_user_input: input,
        render_callout: inline,
      },
    }
  },
}))

// The selector consults the registry to identify input-surface widgets;
// stub it before importing anything that depends on it.
vi.mock('@/components/chat/genui/registry', registryMock)

let selectPendingInputToolCall: typeof import('@/components/chat/genui/pending-input-tool-call').selectPendingInputToolCall

const validInputArguments = JSON.stringify({
  question: 'Pick one',
  options: [{ label: 'A' }, { label: 'B' }],
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
  turnId = 'assistant-turn',
): Message {
  return {
    turnId,
    role: 'assistant',
    content: '',
    timestamp: new Date(0),
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
  beforeAll(async () => {
    ;({ selectPendingInputToolCall } =
      await import('@/components/chat/genui/pending-input-tool-call'))
  })

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
          args: validInputArguments,
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
      messageIndex: 0,
      blockId: 'b1',
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

  it.each([
    '{"question":"Pick one"}',
    '{"question":"Pick one","options":[{"label":"A"},{"label":7}]}',
    '{"question":"Pick one","options":[{"label":"A"},{"label":"B"}],"unexpected":true}',
  ])('returns null for schema-invalid input tool arguments: %s', (args) => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 't1',
          args,
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
          args: validInputArguments,
          resolvedAt: 1,
        },
      ]),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
    const block = msgs[0].timeline?.[0]
    if (!block || block.type !== 'tool_call')
      throw new Error('Missing tool fixture')
    block.resolvedAt = undefined
    expect(selectPendingInputToolCall(msgs)).toMatchObject({ toolCallId: 't1' })
  })

  it('only inspects the LAST assistant message', () => {
    const msgs: Message[] = [
      assistantMessage([
        {
          type: 'tool_call',
          id: 'b1',
          name: 'ask_user_input',
          toolCallId: 'old',
          args: validInputArguments,
        },
      ]),
      {
        turnId: 'user-turn',
        role: 'user',
        content: 'hello',
        timestamp: new Date(1),
      },
      assistantMessage(
        [{ type: 'content', id: 'c1', content: 'hi' }],
        'latest-turn',
      ),
    ]
    expect(selectPendingInputToolCall(msgs)).toBeNull()
  })
})
