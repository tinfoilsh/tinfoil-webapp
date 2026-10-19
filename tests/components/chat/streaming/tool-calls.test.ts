import { createContentPreprocessor } from '@/components/chat/hooks/streaming/content-preprocessor'
import { createEventNormalizer } from '@/components/chat/hooks/streaming/event-normalizer'
import { MessageAssembler } from '@/components/chat/hooks/streaming/message-assembler'
import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
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
  it('emits genui_tool_call_start on first chunk per tool call and deltas thereafter', () => {
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
      { type: 'genui_tool_call_start', id: 'call_1', name: 'render_callout' },
      { type: 'genui_tool_call_delta', id: 'call_1', argumentsDelta: '{"ti' },
    ])

    const second = normalizer.processChunk(
      buildChunk([{ index: 0, argsDelta: 'tle":"Hi"}' }]),
      preprocessor,
    )

    expect(second).toEqual([
      {
        type: 'genui_tool_call_delta',
        id: 'call_1',
        argumentsDelta: 'tle":"Hi"}',
      },
    ])
  })

  it('tracks multiple concurrent tool calls by index', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    normalizer.processChunk(
      buildChunk([
        { index: 0, id: 'call_a', name: 'render_callout' },
        { index: 1, id: 'call_b', name: 'render_chart' },
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
      {
        type: 'genui_tool_call_delta',
        id: 'call_b',
        argumentsDelta: '{"data":',
      },
      {
        type: 'genui_tool_call_delta',
        id: 'call_a',
        argumentsDelta: '{"title":',
      },
    ])
  })

  it('closes an open thinking block before emitting tool_call events', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    normalizer.processChunk(
      { choices: [{ delta: { reasoning_content: 'reasoning' } }] },
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
      type: 'genui_tool_call_start',
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
    tb.startToolCall('call_2', 'render_chart')
    tb.appendToolCallArguments('call_2', '{"data":')
    tb.appendToolCallArguments('call_1', 'tle":"X"}')
    tb.appendToolCallArguments('call_2', '[]}')
    tb.appendToolCallArguments('missing', 'orphan')

    const snapshot = tb.snapshot()
    expect(snapshot).toEqual([
      {
        type: 'tool_call',
        id: 'tool-call-0',
        toolCallId: 'call_1',
        name: 'render_callout',
        arguments: '{"title":"X"}',
      },
      {
        type: 'tool_call',
        id: 'tool-call-1',
        toolCallId: 'call_2',
        name: 'render_chart',
        arguments: '{"data":[]}',
      },
    ])
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
        name: 'render_chart',
        arguments: '{"data":[]}',
      },
    ])

    expect(message.toolCalls).toEqual([
      { id: 'call_1', name: 'render_callout', arguments: '{"title":"Hi"}' },
      { id: 'call_2', name: 'render_chart', arguments: '{"data":[]}' },
    ])
  })
})
