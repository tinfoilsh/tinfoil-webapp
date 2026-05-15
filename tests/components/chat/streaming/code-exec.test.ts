import { createContentPreprocessor } from '@/components/chat/hooks/streaming/content-preprocessor'
import { createEventNormalizer } from '@/components/chat/hooks/streaming/event-normalizer'
import { MessageAssembler } from '@/components/chat/hooks/streaming/message-assembler'
import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
import type { TimelineCodeExecBlock } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

// Build a streaming chunk whose `delta.content` carries a tinfoil marker.
// The preprocessor strips the marker and yields the parsed event to the
// normalizer, which then emits a `code_exec_tool_call` NormalizedEvent.
function tinfoilMarker(payload: object): string {
  return `<tinfoil-event>${JSON.stringify(payload)}</tinfoil-event>`
}

function buildContentChunk(content: string) {
  return { choices: [{ delta: { content } }] }
}

describe('event-normalizer code_exec_tool_call handling', () => {
  it('normalizes an in_progress tinfoil.tool_call marker', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    const events = normalizer.processChunk(
      buildContentChunk(
        tinfoilMarker({
          type: 'tinfoil.tool_call',
          item_id: 'call_1',
          status: 'in_progress',
          tool: { name: 'bash', arguments: { command: 'ls -la' } },
        }),
      ),
      preprocessor,
    )

    expect(events).toContainEqual({
      type: 'code_exec_tool_call',
      id: 'call_1',
      toolName: 'bash',
      status: 'in_progress',
      arguments: { command: 'ls -la' },
      output: undefined,
    })
  })

  it('normalizes a completed marker with output', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    const events = normalizer.processChunk(
      buildContentChunk(
        tinfoilMarker({
          type: 'tinfoil.tool_call',
          item_id: 'call_1',
          status: 'completed',
          tool: { name: 'bash', output: 'total 0\n' },
        }),
      ),
      preprocessor,
    )

    expect(events).toContainEqual({
      type: 'code_exec_tool_call',
      id: 'call_1',
      toolName: 'bash',
      status: 'completed',
      arguments: undefined,
      output: 'total 0\n',
    })
  })

  it('passes blocked/failed status through unchanged (process-stream maps to failed)', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    const events = normalizer.processChunk(
      buildContentChunk(
        tinfoilMarker({
          type: 'tinfoil.tool_call',
          item_id: 'call_1',
          status: 'blocked',
          tool: { name: 'bash' },
        }),
      ),
      preprocessor,
    )

    const event = events.find((e) => e.type === 'code_exec_tool_call')
    expect(event).toBeDefined()
    if (event && event.type === 'code_exec_tool_call') {
      expect(event.status).toBe('blocked')
    }
  })

  it('drops events without item_id (no clock-based fallback)', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    const events = normalizer.processChunk(
      buildContentChunk(
        tinfoilMarker({
          type: 'tinfoil.tool_call',
          status: 'in_progress',
          tool: { name: 'bash', arguments: { command: 'ls' } },
        }),
      ),
      preprocessor,
    )

    expect(events.filter((e) => e.type === 'code_exec_tool_call')).toEqual([])
  })

  it('closes an open thinking block before emitting a code_exec_tool_call event', () => {
    const normalizer = createEventNormalizer()
    const preprocessor = createContentPreprocessor()

    normalizer.processChunk(buildContentChunk('<think>reasoning'), preprocessor)

    const events = normalizer.processChunk(
      buildContentChunk(
        tinfoilMarker({
          type: 'tinfoil.tool_call',
          item_id: 'call_1',
          status: 'in_progress',
          tool: { name: 'bash', arguments: { command: 'ls' } },
        }),
      ),
      preprocessor,
    )

    const thinkingEndIdx = events.findIndex((e) => e.type === 'thinking_end')
    const codeExecIdx = events.findIndex(
      (e) => e.type === 'code_exec_tool_call',
    )
    expect(thinkingEndIdx).toBeGreaterThanOrEqual(0)
    expect(codeExecIdx).toBeGreaterThan(thinkingEndIdx)
  })
})

describe('TimelineBuilder code-exec operations', () => {
  it('pushCodeExecCall creates a new code_exec block on first call', () => {
    const tb = new TimelineBuilder()
    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      arguments: { command: 'ls' },
      status: 'running',
    })

    const snapshot = tb.snapshot()
    expect(snapshot).toHaveLength(1)
    const block = snapshot[0] as TimelineCodeExecBlock
    expect(block.type).toBe('code_exec')
    expect(block.calls).toHaveLength(1)
    expect(block.calls[0].id).toBe('call_1')
  })

  it('consecutive pushCodeExecCall merges into the last code_exec block', () => {
    const tb = new TimelineBuilder()
    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      status: 'running',
    })
    tb.pushCodeExecCall({
      id: 'call_2',
      toolName: 'view',
      status: 'running',
    })

    const snapshot = tb.snapshot()
    expect(snapshot).toHaveLength(1)
    const block = snapshot[0] as TimelineCodeExecBlock
    expect(block.calls.map((c) => c.id)).toEqual(['call_1', 'call_2'])
  })

  it('a non-code-exec block in between starts a fresh code_exec block', () => {
    const tb = new TimelineBuilder()
    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      status: 'running',
    })
    tb.appendContent('intermission')
    tb.pushCodeExecCall({
      id: 'call_2',
      toolName: 'view',
      status: 'running',
    })

    const snapshot = tb.snapshot()
    expect(snapshot.map((b) => b.type)).toEqual([
      'code_exec',
      'content',
      'code_exec',
    ])
    expect((snapshot[0] as TimelineCodeExecBlock).calls).toHaveLength(1)
    expect((snapshot[2] as TimelineCodeExecBlock).calls).toHaveLength(1)
  })

  it('updateCodeExecCall updates the matching call by id', () => {
    const tb = new TimelineBuilder()
    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      status: 'running',
    })
    tb.updateCodeExecCall('call_1', {
      status: 'completed',
      output: 'done',
    })

    const block = tb.snapshot()[0] as TimelineCodeExecBlock
    expect(block.calls[0].status).toBe('completed')
    expect(block.calls[0].output).toBe('done')
  })

  it('updateCodeExecCall silently no-ops when id does not match', () => {
    const tb = new TimelineBuilder()
    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      status: 'running',
    })
    tb.updateCodeExecCall('call_unknown', {
      status: 'completed',
      output: 'ghost',
    })

    const block = tb.snapshot()[0] as TimelineCodeExecBlock
    expect(block.calls).toHaveLength(1)
    expect(block.calls[0].status).toBe('running')
    expect(block.calls[0].output).toBeUndefined()
  })

  it('pushCodeExecCall closes an open thinking block', () => {
    const tb = new TimelineBuilder()
    tb.startThinking()
    tb.appendThinking('thinking...')
    expect(tb.isThinkingOpen).toBe(true)

    tb.pushCodeExecCall({
      id: 'call_1',
      toolName: 'bash',
      status: 'running',
    })

    expect(tb.isThinkingOpen).toBe(false)
    const snapshot = tb.snapshot()
    expect(snapshot.map((b) => b.type)).toEqual(['thinking', 'code_exec'])
  })
})

describe('MessageAssembler code-exec derivation', () => {
  it('derives Message.codeExecCalls from timeline code_exec blocks', () => {
    const asm = new MessageAssembler()
    const message = asm.toMessage([
      {
        type: 'code_exec',
        id: 'ce-0',
        calls: [
          {
            id: 'call_1',
            toolName: 'bash',
            arguments: { command: 'ls' },
            status: 'completed',
            output: 'a\nb\n',
          },
          {
            id: 'call_2',
            toolName: 'view',
            status: 'running',
          },
        ],
      },
    ])

    expect(message.codeExecCalls).toHaveLength(2)
    expect(message.codeExecCalls?.[0]).toEqual({
      id: 'call_1',
      toolName: 'bash',
      arguments: { command: 'ls' },
      status: 'completed',
      output: 'a\nb\n',
    })
    expect(message.codeExecCalls?.[1].toolName).toBe('view')
  })

  it('flattens calls across multiple code_exec blocks in order', () => {
    const asm = new MessageAssembler()
    const message = asm.toMessage([
      {
        type: 'code_exec',
        id: 'ce-0',
        calls: [{ id: 'call_1', toolName: 'bash', status: 'completed' }],
      },
      { type: 'content', id: 'c', content: 'between' },
      {
        type: 'code_exec',
        id: 'ce-1',
        calls: [{ id: 'call_2', toolName: 'view', status: 'completed' }],
      },
    ])

    expect(message.codeExecCalls?.map((c) => c.id)).toEqual([
      'call_1',
      'call_2',
    ])
  })

  it('omits codeExecCalls when the timeline has none', () => {
    const asm = new MessageAssembler()
    const message = asm.toMessage([
      { type: 'content', id: 'c', content: 'plain' },
    ])
    expect(message.codeExecCalls).toBeUndefined()
  })
})
