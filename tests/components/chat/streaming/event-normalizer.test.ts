import { createContentPreprocessor } from '@/components/chat/hooks/streaming/content-preprocessor'
import { createEventNormalizer } from '@/components/chat/hooks/streaming/event-normalizer'
import type { NormalizedEvent } from '@/components/chat/hooks/streaming/types'
import { describe, expect, it } from 'vitest'

/** Helper: run a sequence of SSE JSON chunks through the normalizer. */
function processAll(chunks: Record<string, unknown>[]): NormalizedEvent[] {
  const normalizer = createEventNormalizer()
  const preprocessor = createContentPreprocessor()
  const events: NormalizedEvent[] = []
  for (const chunk of chunks) {
    events.push(...normalizer.processChunk(chunk, preprocessor))
  }
  events.push(...normalizer.flush())
  return events
}

/** Shorthand for an SSE chunk with delta.content. */
function contentChunk(content: string): Record<string, unknown> {
  return { choices: [{ delta: { content } }] }
}

/** Shorthand for an SSE chunk with delta.reasoning_content. */
function reasoningChunk(
  reasoning: string,
  content = '',
): Record<string, unknown> {
  return {
    choices: [
      {
        delta: {
          reasoning_content: reasoning || undefined,
          ...(content ? { content } : {}),
        },
      },
    ],
  }
}

describe('EventNormalizer', () => {
  describe('plain content (no thinking)', () => {
    it('emits content_delta for simple text', () => {
      const events = processAll([contentChunk('hello'), contentChunk(' world')])
      expect(events).toEqual([
        { type: 'content_delta', content: 'hello' },
        { type: 'content_delta', content: ' world' },
      ])
    })

    it('skips empty content chunks', () => {
      const events = processAll([contentChunk(''), contentChunk('hi')])
      expect(events).toEqual([{ type: 'content_delta', content: 'hi' }])
    })

    it('emits tag-like text immediately and unchanged', () => {
      const events = processAll([
        contentChunk('<th'),
        contentChunk('ink>literal</think>'),
      ])

      expect(events).toEqual([
        { type: 'content_delta', content: '<th' },
        { type: 'content_delta', content: 'ink>literal</think>' },
      ])
    })
  })

  describe('reasoning_content format (OpenAI-style)', () => {
    it.each([
      ['delta.reasoning', { choices: [{ delta: { reasoning: 'thinking' } }] }],
      [
        'message.reasoning_content',
        {
          choices: [{ delta: {}, message: { reasoning_content: 'thinking' } }],
        },
      ],
      [
        'message.reasoning',
        { choices: [{ delta: {}, message: { reasoning: 'thinking' } }] },
      ],
    ])('reads thinking from %s', (_field, chunk) => {
      expect(processAll([chunk])).toEqual([
        { type: 'thinking_start' },
        { type: 'thinking_delta', content: 'thinking' },
        { type: 'thinking_end' },
      ])
    })

    it('preserves reasoning whitespace exactly', () => {
      expect(
        processAll([
          {
            choices: [
              { delta: {}, message: { reasoning_content: '  thinking  ' } },
            ],
          },
        ]),
      ).toEqual([
        { type: 'thinking_start' },
        { type: 'thinking_delta', content: '  thinking  ' },
        { type: 'thinking_end' },
      ])
    })

    it('prefers a streaming delta over a cumulative message value', () => {
      expect(
        processAll([
          {
            choices: [
              {
                delta: { reasoning_content: ' delta' },
                message: { reasoning_content: 'cumulative delta' },
              },
            ],
          },
        ]),
      ).toEqual([
        { type: 'thinking_start' },
        { type: 'thinking_delta', content: ' delta' },
        { type: 'thinking_end' },
      ])
    })

    it('detects reasoning format from first reasoning chunk', () => {
      const events = processAll([
        reasoningChunk('thinking...'),
        reasoningChunk('more thinking'),
        { choices: [{ delta: { content: 'answer' } }] },
      ])

      const types = events.map((e) => e.type)
      expect(types).toEqual([
        'thinking_start',
        'thinking_delta',
        'thinking_delta',
        'thinking_end',
        'content_delta',
      ])
    })

    it('closes active structured reasoning when the stream is flushed', () => {
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      expect(normalizer.flush()).toEqual([])
      normalizer.processChunk(reasoningChunk('thinking'), preprocessor)

      expect(normalizer.flush()).toEqual([{ type: 'thinking_end' }])
      expect(normalizer.flush()).toEqual([])
    })

    it('handles reasoning with empty string (present but empty)', () => {
      const chunk = {
        choices: [{ delta: { reasoning_content: '' } }],
      }
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()
      // First chunk has reasoning_content present (not null), so enters reasoning format
      expect(normalizer.processChunk(chunk, preprocessor)).toEqual([
        { type: 'thinking_start' },
      ])
      expect(
        normalizer.processChunk(reasoningChunk('actual thought'), preprocessor),
      ).toEqual([{ type: 'thinking_delta', content: 'actual thought' }])
      expect(normalizer.flush()).toEqual([{ type: 'thinking_end' }])
    })

    it('emits content carried on the same chunk as the first reasoning', () => {
      const events = processAll([
        {
          choices: [
            { delta: { reasoning_content: 'quick thought. ', content: 'Hi' } },
          ],
        },
        { choices: [{ delta: { content: ' there' } }] },
      ])

      const types = events.map((e) => e.type)
      expect(types).toEqual([
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'content_delta',
        'content_delta',
      ])
      expect((events[3] as any).content).toBe('Hi')
    })

    it('does not drop content on chunks carrying an empty reasoning field after thinking ended', () => {
      const events = processAll([
        reasoningChunk('thinking about the email...'),
        {
          choices: [
            {
              delta: { reasoning_content: '', content: 'It’s clear and poli' },
            },
          ],
        },
        {
          choices: [
            { delta: { reasoning_content: '', content: 'te, but hone' } },
          ],
        },
        { choices: [{ delta: { content: 'stly?' } }] },
      ])

      const text = events
        .filter((e) => e.type === 'content_delta')
        .map((e) => (e as any).content)
        .join('')
      expect(text).toBe('It’s clear and polite, but honestly?')
    })

    it.each([' for.', '. '])(
      'merges substantive reasoning tails arriving after content into the previous thinking block',
      (tail) => {
        // Upstream splits the think-close boundary, so the final reasoning
        // fragment (" for.") can land after the answer already started.
        const events = processAll([
          reasoningChunk('I should account'),
          { choices: [{ delta: { content: 'The' } }] },
          reasoningChunk(tail),
          { choices: [{ delta: { content: ' main things were:' } }] },
        ])

        const types = events.map((e) => e.type)
        expect(types.filter((t) => t === 'thinking_start').length).toBe(1)
        expect(types.filter((t) => t === 'thinking_end').length).toBe(1)
        expect(events).toContainEqual({
          type: 'thinking_tail_delta',
          content: tail,
        })
        const text = events
          .filter((e) => e.type === 'content_delta')
          .map((e) => (e as any).content)
          .join('')
        expect(text).toBe('The main things were:')
      },
    )

    it.each(['offs. ', ' '])(
      'merges a reasoning tail carried on the same chunk as content',
      (tail) => {
        const events = processAll([
          reasoningChunk('thinking about trade'),
          reasoningChunk('. ', 'Answer start'),
          reasoningChunk(tail, ' **TCP** is reliable'),
        ])

        expect(events).toEqual([
          { type: 'thinking_start' },
          { type: 'thinking_delta', content: 'thinking about trade' },
          { type: 'thinking_delta', content: '. ' },
          { type: 'thinking_end' },
          { type: 'content_delta', content: 'Answer start' },
          { type: 'thinking_tail_delta', content: tail },
          { type: 'content_delta', content: ' **TCP** is reliable' },
        ])
      },
    )

    it('opens a new thinking block when reasoning resumes after a tool call', () => {
      const events = processAll([
        reasoningChunk('first thoughts'),
        { choices: [{ delta: { content: 'Intro text' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_widget',
                    type: 'function',
                    function: {
                      name: 'render_stat_cards',
                      arguments: '{"stats":[]}',
                    },
                  },
                ],
              },
            },
          ],
        },
        reasoningChunk('second phase thoughts'),
        { choices: [{ delta: { content: 'Final answer' } }] },
      ])

      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === 'thinking_start').length).toBe(2)
      expect(types.filter((t) => t === 'thinking_end').length).toBe(2)
      expect(types).not.toContain('thinking_tail_delta')
    })
  })

  describe('annotations', () => {
    it('extracts url_citation annotations', () => {
      const chunk = {
        choices: [
          {
            delta: {
              content: '',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://example.com',
                    title: 'Example',
                  },
                },
              ],
            },
          },
        ],
      }
      const events = processAll([chunk])
      expect(events).toContainEqual({
        type: 'annotation',
        url: 'https://example.com',
        title: 'Example',
      })
    })

    it('ignores non-url_citation annotations', () => {
      const chunk = {
        choices: [
          {
            delta: {
              content: '',
              annotations: [{ type: 'other_type', data: 'something' }],
            },
          },
        ],
      }
      const events = processAll([chunk])
      expect(events.filter((e) => e.type === 'annotation')).toEqual([])
    })
  })

  describe('search reasoning', () => {
    it('extracts search_reasoning from delta', () => {
      const chunk = {
        choices: [
          { delta: { content: '', search_reasoning: 'looking for X' } },
        ],
      }
      const events = processAll([chunk])
      expect(events).toContainEqual({
        type: 'search_reasoning',
        content: 'looking for X',
      })
    })
  })

  describe('tool calls', () => {
    it('allows content after a tool-call turn finishes', () => {
      const events = processAll([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_widget',
                    type: 'function',
                    function: {
                      name: 'render_stat_cards',
                      arguments: '{"stats":[]}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        contentChunk('continued answer'),
      ])

      expect(events).toContainEqual({
        type: 'genui_tool_call_start',
        id: 'call_widget',
        name: 'render_stat_cards',
      })
      expect(events).toContainEqual({
        type: 'content_delta',
        content: 'continued answer',
      })
    })

    it('allows post-widget prose when the router internally continues without a finish boundary', () => {
      const events = processAll([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_widget',
                    type: 'function',
                    function: {
                      name: 'render_stat_cards',
                      arguments: '{"stats":[]}',
                    },
                  },
                ],
              },
            },
          ],
        },
        contentChunk(' N'),
        contentChunk('AD'),
        contentChunk('+'),
        contentChunk(' is important.'),
      ])

      expect(
        events
          .filter((event) => event.type === 'content_delta')
          .map((event) => event.content)
          .join(''),
      ).toBe(' NAD+ is important.')
    })

    it('starts a new tool call when router continuations reuse index zero', () => {
      const events = processAll([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_first',
                    type: 'function',
                    function: {
                      name: 'render_stat_cards',
                      arguments: '{"stats":[]}',
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
                    id: 'call_second',
                    type: 'function',
                    function: {
                      name: 'render_chart',
                      arguments: '{"series":[]}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ])

      expect(events).toContainEqual({
        type: 'genui_tool_call_start',
        id: 'call_first',
        name: 'render_stat_cards',
      })
      expect(events).toContainEqual({
        type: 'genui_tool_call_delta',
        id: 'call_first',
        argumentsDelta: '{"stats":[]}',
      })
      expect(events).toContainEqual({
        type: 'genui_tool_call_start',
        id: 'call_second',
        name: 'render_chart',
      })
      expect(events).toContainEqual({
        type: 'genui_tool_call_delta',
        id: 'call_second',
        argumentsDelta: '{"series":[]}',
      })
    })
  })

  describe('legacy web_search_call events', () => {
    it('normalizes top-level web_search_call', () => {
      const chunk = {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'searching',
        action: { query: 'test query' },
      }
      const events = processAll([chunk])
      expect(events).toContainEqual({
        type: 'web_search',
        id: 'ws_1',
        status: 'in_progress',
        query: 'test query',
        reason: undefined,
      })
    })

    it('closes thinking before emitting web_search_call', () => {
      const events = processAll([
        reasoningChunk('thinking'),
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'searching',
          action: { query: 'q' },
        },
      ])

      expect(events).toEqual([
        { type: 'thinking_start' },
        { type: 'thinking_delta', content: 'thinking' },
        { type: 'thinking_end' },
        {
          type: 'web_search',
          id: 'ws_1',
          status: 'in_progress',
          query: 'q',
          reason: undefined,
        },
      ])
    })
  })
})
