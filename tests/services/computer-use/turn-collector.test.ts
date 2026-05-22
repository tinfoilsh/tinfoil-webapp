import type { ChatChunk } from '@/services/computer-use/chat-protocol'
import { collectTurn } from '@/services/computer-use/turn-collector'
import { describe, expect, it } from 'vitest'
import { toolCallChunks } from './fixtures'

async function* stream(chunks: ChatChunk[]): AsyncGenerator<ChatChunk> {
  for (const c of chunks) yield c
}

describe('collectTurn', () => {
  it('accumulates content and reasoning separately', async () => {
    const turn = await collectTurn(
      stream([
        { choices: [{ delta: { reasoning: 'thinking ' } }] },
        { choices: [{ delta: { reasoning: 'more' } }] },
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
      ]),
    )
    expect(turn.content).toBe('Hello world')
    expect(turn.reasoning).toBe('thinking more')
    expect(turn.toolCalls).toEqual([])
    expect(turn.finishReason).toBe('stop')
  })

  it('also reads reasoning under the reasoning_content alias', async () => {
    const turn = await collectTurn(
      stream([
        {
          choices: [
            { delta: { reasoning_content: 'r' }, finish_reason: 'stop' },
          ],
        },
      ]),
    )
    expect(turn.reasoning).toBe('r')
  })

  it('assembles a tool call from streamed argument deltas', async () => {
    const turn = await collectTurn(
      stream(
        toolCallChunks({
          id: 'c1',
          name: 'computer',
          arguments: '{"type":"click","x":1,"y":2}',
        }),
      ),
    )
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0]).toMatchObject({
      id: 'c1',
      function: { name: 'computer', arguments: '{"type":"click","x":1,"y":2}' },
    })
    expect(turn.finishReason).toBe('tool_calls')
  })
})
