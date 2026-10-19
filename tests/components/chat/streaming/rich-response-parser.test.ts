import { parseRichStreamingResponse } from '@/components/chat/hooks/streaming'
import type {
  ChatChunk,
  ChatChunkStream,
} from '@/services/inference/chat-stream'
import { describe, expect, it, vi } from 'vitest'

function chunkStream(events: ChatChunk[]): ChatChunkStream {
  return (async function* () {
    yield* events
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  })()
}

function chunkStreamWithoutCompletion(events: ChatChunk[]): ChatChunkStream {
  return (async function* () {
    yield* events
  })()
}

describe('parseRichStreamingResponse', () => {
  it('rejects a stream without an authenticated completion marker', async () => {
    const response = chunkStreamWithoutCompletion([
      { choices: [{ delta: { content: 'partial' } }] },
    ])

    await expect(parseRichStreamingResponse(response)).rejects.toThrow(
      'Chat response ended before its completion marker',
    )
  })

  it('accepts a completion marker without relying on the SSE sentinel', async () => {
    const response = chunkStreamWithoutCompletion([
      { choices: [{ delta: { content: 'complete' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ])

    await expect(parseRichStreamingResponse(response)).resolves.toMatchObject({
      content: 'complete',
    })
  })

  it('ends the initial wait when URL fetching begins', async () => {
    const onFirstEvent = vi.fn()
    const onUpdate = vi.fn()
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const parsing = parseRichStreamingResponse(
      (async function* (): AsyncGenerator<ChatChunk> {
        yield {
          choices: [
            {
              delta: {
                content:
                  '<tinfoil-event>{"type":"tinfoil.web_search_call","item_id":"fetch-1","status":"in_progress","action":{"type":"open_page","url":"https://example.com"}}</tinfoil-event>',
              },
            },
          ],
        }
        await completion
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      })(),
      { onFirstEvent, onUpdate },
    )

    try {
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled())
      expect(onFirstEvent).toHaveBeenCalledOnce()
      expect(onUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          urlFetches: [
            { id: 'fetch-1', url: 'https://example.com', status: 'fetching' },
          ],
        }),
      )
    } finally {
      finish()
      await parsing
    }
  })

  it('reconstructs reasoning, content, citations, and tool calls', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          choices: [{ delta: { reasoning_content: 'Check sources. ' } }],
        },
        {
          choices: [
            {
              delta: {
                content: 'Final answer.',
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: {
                      title: 'Example',
                      url: 'https://example.com',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'render_card', arguments: '{"x":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '1}' },
                  },
                ],
              },
            },
          ],
        },
      ]),
    )

    expect(message.content).toBe('Final answer.')
    expect(message.thoughts).toBe('Check sources. ')
    expect(message.thinkingDuration).toBeUndefined()
    expect(message.annotations).toEqual([
      {
        type: 'url_citation',
        url_citation: {
          title: 'Example',
          url: 'https://example.com',
        },
      },
    ])
    expect(message.toolCalls).toEqual([
      { id: 'call-1', name: 'render_card', arguments: '{"x":1}' },
    ])
    expect(message.timeline?.map((block) => block.type)).toEqual([
      'thinking',
      'content',
      'tool_call',
    ])
  })

  it('keeps separate terminal-only web searches distinct', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
          action: { query: 'first query' },
        },
        {
          type: 'web_search_call',
          id: 'search-2',
          status: 'completed',
          action: { query: 'second query' },
        },
      ]),
    )

    expect(
      message.timeline
        ?.filter((block) => block.type === 'web_search')
        .map((block) => block.state),
    ).toEqual([
      { query: 'first query', status: 'completed', sources: [] },
      { query: 'second query', status: 'completed', sources: [] },
    ])
    expect(message.webSearch).toEqual({
      query: 'second query',
      status: 'completed',
      sources: [],
    })
  })

  it('matches interleaved web-search completions by event ID', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'in_progress',
          action: { query: 'first query' },
        },
        {
          type: 'web_search_call',
          id: 'search-2',
          status: 'in_progress',
          action: { query: 'second query' },
        },
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
        },
      ]),
    )

    expect(
      message.timeline
        ?.filter((block) => block.type === 'web_search')
        .map((block) => block.state),
    ).toEqual([
      expect.objectContaining({ query: 'first query', status: 'completed' }),
      expect.objectContaining({ query: 'second query', status: 'searching' }),
    ])
  })

  it('updates a blocked web search by event ID', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'in_progress',
          action: { query: 'blocked query' },
        },
        {
          type: 'web_search_call',
          id: 'search-2',
          status: 'in_progress',
          action: { query: 'unrelated query' },
        },
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'blocked',
          reason: 'policy',
        },
      ]),
    )

    expect(
      message.timeline?.filter((block) => block.type === 'web_search'),
    ).toEqual([
      expect.objectContaining({
        state: {
          query: 'blocked query',
          status: 'blocked',
          reason: 'policy',
        },
      }),
      expect.objectContaining({
        state: { query: 'unrelated query', status: 'searching' },
      }),
    ])
  })

  it('matches an id-less blocked search by query', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          status: 'in_progress',
          action: { query: 'first query' },
        },
        {
          type: 'web_search_call',
          status: 'in_progress',
          action: { query: 'second query' },
        },
        {
          type: 'web_search_call',
          status: 'blocked',
          action: { query: 'first query' },
          reason: 'policy',
        },
      ]),
    )

    expect(
      message.timeline
        ?.filter((block) => block.type === 'web_search')
        .map((block) => block.state),
    ).toEqual([
      {
        query: 'first query',
        status: 'blocked',
        reason: 'policy',
      },
      {
        query: 'second query',
        status: 'searching',
      },
    ])
  })

  it('matches an identified terminal event to an id-less search start', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          status: 'in_progress',
          action: { query: 'mixed identity query' },
        },
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
          action: { query: 'mixed identity query' },
        },
      ]),
    )

    expect(
      message.timeline?.filter((block) => block.type === 'web_search'),
    ).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({
          query: 'mixed identity query',
          status: 'completed',
        }),
      }),
    ])
  })

  it('does not match an identified terminal event to concurrent id-less searches', async () => {
    const message = await parseRichStreamingResponse(
      chunkStream([
        {
          type: 'web_search_call',
          status: 'in_progress',
          action: { query: 'first query' },
        },
        {
          type: 'web_search_call',
          status: 'in_progress',
          action: { query: 'second query' },
        },
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
        },
      ]),
    )

    expect(
      message.timeline
        ?.filter((block) => block.type === 'web_search')
        .map((block) => block.state),
    ).toEqual([
      expect.objectContaining({ query: 'first query', status: 'searching' }),
      expect.objectContaining({ query: 'second query', status: 'searching' }),
      expect.objectContaining({ status: 'completed' }),
    ])
  })

  it('ends thinking callbacks when the response stream fails', async () => {
    const response = (async function* (): AsyncGenerator<ChatChunk> {
      yield { choices: [{ delta: { reasoning_content: 'thinking' } }] }
      throw new Error('stream failed')
    })()
    const thinkingChanges: boolean[] = []

    await expect(
      parseRichStreamingResponse(response, {
        onThinkingChange: (thinking) => thinkingChanges.push(thinking),
      }),
    ).rejects.toThrow('stream failed')
    expect(thinkingChanges).toEqual([true, false])
  })
})
