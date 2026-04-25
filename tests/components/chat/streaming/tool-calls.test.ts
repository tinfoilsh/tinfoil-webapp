import { createContentPreprocessor } from '@/components/chat/hooks/streaming/content-preprocessor'
import { createEventNormalizer } from '@/components/chat/hooks/streaming/event-normalizer'
import { MessageAssembler } from '@/components/chat/hooks/streaming/message-assembler'
import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
import type { TimelineToolCallBlock } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

function buildChunk(
  toolCalls: Array<{
    index: number
    id?: string
    name?: string
    argsDelta?: string
  }>,
) {
  return {
    choices: [
      {
        delta: {
          tool_calls: toolCalls.map((tc) => ({
            index: tc.index,
            ...(tc.id !== undefined ? { id: tc.id } : {}),
            type: 'function',
            function: {
              ...(tc.name !== undefined ? { name: tc.name } : {}),
              ...(tc.argsDelta !== undefined
                ? { arguments: tc.argsDelta }
                : {}),
            },
          })),
        },
      },
    ],
  }
}

describe('event-normalizer tool_call handling', () => {
  it('emits tool_call_start on first chunk per tool call and deltas thereafter', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    const first = normalizer.processChunk(
      buildChunk([
        {
          index: 0,
          id: 'call_1',
          name: 'render_callout',
          argsDelta: '{"ti',
        },
      ]),
      preprocessor,
    )

    expect(first).toEqual([
      { type: 'tool_call_start', id: 'call_1', name: 'render_callout' },
      { type: 'tool_call_delta', id: 'call_1', argumentsDelta: '{"ti' },
    ])

    const second = normalizer.processChunk(
      buildChunk([{ index: 0, argsDelta: 'tle":"Hi"}' }]),
      preprocessor,
    )

    expect(second).toEqual([
      { type: 'tool_call_delta', id: 'call_1', argumentsDelta: 'tle":"Hi"}' },
    ])
  })

  it('tracks multiple concurrent tool calls by index', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    normalizer.processChunk(
      buildChunk([
        { index: 0, id: 'call_a', name: 'render_callout' },
        { index: 1, id: 'call_b', name: 'render_bar_chart' },
      ]),
      preprocessor,
    )

    const next = normalizer.processChunk(
      buildChunk([
        { index: 1, argsDelta: '{"data":' },
        { index: 0, argsDelta: '{"title":' },
      ]),
      preprocessor,
    )

    expect(next).toEqual([
      { type: 'tool_call_delta', id: 'call_b', argumentsDelta: '{"data":' },
      { type: 'tool_call_delta', id: 'call_a', argumentsDelta: '{"title":' },
    ])
  })

  it('closes an open thinking block before emitting tool_call events', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    // Put the normalizer into thinking state via <think>
    normalizer.processChunk(
      { choices: [{ delta: { content: '<think>reasoning' } }] },
      preprocessor,
    )

    const events = normalizer.processChunk(
      buildChunk([
        {
          index: 0,
          id: 'call_1',
          name: 'render_callout',
          argsDelta: '{}',
        },
      ]),
      preprocessor,
    )

    expect(events[0]).toEqual({ type: 'thinking_end' })
    expect(events).toContainEqual({
      type: 'tool_call_start',
      id: 'call_1',
      name: 'render_callout',
    })
  })
})

describe('TimelineBuilder tool_call operations', () => {
  it('accumulates argument deltas onto the matching block', () => {
    const tb = new TimelineBuilder()
    tb.startToolCall('call_1', 'render_callout')
    tb.appendToolCallArguments('call_1', '{"ti')
    tb.appendToolCallArguments('call_1', 'tle":"X"}')

    const snapshot = tb.snapshot()
    expect(snapshot).toHaveLength(1)
    const block = snapshot[0] as TimelineToolCallBlock
    expect(block.type).toBe('tool_call')
    expect(block.arguments).toBe('{"title":"X"}')
    expect(block.name).toBe('render_callout')
  })

  it('resolveToolCall stamps the block with the resolution', () => {
    const tb = new TimelineBuilder()
    tb.startToolCall('call_1', 'ask_user_input')
    tb.appendToolCallArguments('call_1', '{}')
    tb.resolveToolCall('call_1', {
      text: 'Option A',
      data: { value: 'a' },
      resolvedAt: 1234,
    })

    const block = tb.snapshot()[0] as TimelineToolCallBlock
    expect(block.resolvedAt).toBe(1234)
    expect(block.resolution?.text).toBe('Option A')
    expect(block.resolution?.data).toEqual({ value: 'a' })
  })

  it('tool_call arrival closes an open thinking block', () => {
    const tb = new TimelineBuilder()
    tb.startThinking()
    tb.appendThinking('thinking...')
    expect(tb.isThinkingOpen).toBe(true)

    tb.startToolCall('call_1', 'render_callout')

    expect(tb.isThinkingOpen).toBe(false)
    const snapshot = tb.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0].type).toBe('thinking')
    expect(snapshot[1].type).toBe('tool_call')
  })
})

describe('MessageAssembler tool_call derivation', () => {
  it('derives Message.toolCalls from timeline tool_call blocks', () => {
    const asm = new MessageAssembler()
    const message = asm.toMessage([
      {
        type: 'tool_call',
        id: 'tc-0',
        toolCallId: 'call_1',
        name: 'render_callout',
        arguments: '{"title":"Hi"}',
      },
      {
        type: 'tool_call',
        id: 'tc-1',
        toolCallId: 'call_2',
        name: 'render_bar_chart',
        arguments: '{"data":[]}',
      },
    ])

    expect(message.toolCalls).toHaveLength(2)
    expect(message.toolCalls?.[0]).toEqual({
      id: 'call_1',
      name: 'render_callout',
      arguments: '{"title":"Hi"}',
    })
  })

  it('omits toolCalls when the timeline has none', () => {
    const asm = new MessageAssembler()
    const message = asm.toMessage([
      { type: 'content', id: 'c', content: 'plain' },
    ])
    expect(message.toolCalls).toBeUndefined()
  })
})
