import { parseRichStreamingResponse } from '@/components/chat/hooks/streaming'
import { describe, expect, it } from 'vitest'

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('parseRichStreamingResponse', () => {
  it('reconstructs reasoning, content, citations, and tool calls', async () => {
    const message = await parseRichStreamingResponse(
      sseResponse([
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
    expect(message.thoughts).toBe('Check sources.')
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

  it('preserves the query from a terminal-only web search event', async () => {
    const message = await parseRichStreamingResponse(
      sseResponse([
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
          action: { query: 'actual query' },
        },
      ]),
    )

    expect(message.webSearch).toMatchObject({
      query: 'actual query',
      status: 'completed',
    })
  })

  it('keeps separate terminal-only web searches distinct', async () => {
    const message = await parseRichStreamingResponse(
      sseResponse([
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
        .map((block) => block.state.query),
    ).toEqual(['first query', 'second query'])
  })

  it('matches interleaved web-search completions by event ID', async () => {
    const message = await parseRichStreamingResponse(
      sseResponse([
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
      sseResponse([
        {
          type: 'web_search_call',
          id: 'search-1',
          status: 'in_progress',
          action: { query: 'blocked query' },
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
    ])
  })

  it('matches an id-less blocked search by query', async () => {
    const message = await parseRichStreamingResponse(
      sseResponse([
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
      sseResponse([
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
      sseResponse([
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
    const encoder = new TextEncoder()
    let emitted = false
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (!emitted) {
            emitted = true
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { reasoning_content: 'thinking' } }],
                })}\n\n`,
              ),
            )
            return
          }
          controller.error(new Error('stream failed'))
        },
      }),
    )
    const thinkingChanges: boolean[] = []

    await expect(
      parseRichStreamingResponse(response, {
        onThinkingChange: (thinking) => thinkingChanges.push(thinking),
      }),
    ).rejects.toThrow('stream failed')
    expect(thinkingChanges).toEqual([true, false])
  })
})
