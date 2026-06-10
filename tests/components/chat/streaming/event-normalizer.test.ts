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
      // First-chunk buffering merges short initial chunks until buffer > 5 chars
      const events = processAll([contentChunk('hello'), contentChunk(' world')])
      expect(events).toEqual([
        { type: 'content_delta', content: 'hello world' },
      ])
    })

    it('emits separate deltas after first chunk is flushed', () => {
      const events = processAll([
        contentChunk('hello world'), // > 5 chars, flushes immediately
        contentChunk(' more'),
      ])
      expect(events).toEqual([
        { type: 'content_delta', content: 'hello world' },
        { type: 'content_delta', content: ' more' },
      ])
    })

    it('skips empty content chunks', () => {
      const events = processAll([contentChunk(''), contentChunk('hi')])
      expect(events).toEqual([{ type: 'content_delta', content: 'hi' }])
    })

    it('strips stray <think> tags from non-first-chunk content', () => {
      // Stray tags are only stripped in plain content mode (after first-chunk detection).
      // A <think> in the first chunk is treated as a real thinking block.
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      // Flush first-chunk buffer with non-think content
      normalizer.processChunk(contentChunk('initial text here'), preprocessor)
      // Now subsequent chunks with stray tags get stripped
      const events = normalizer.processChunk(
        contentChunk('before<think>after'),
        preprocessor,
      )
      expect(events).toEqual([
        { type: 'content_delta', content: 'beforeafter' },
      ])
    })
  })

  describe('<think> tag format (DeepSeek-style)', () => {
    it('handles think open and close in separate chunks', () => {
      const events = processAll([
        contentChunk('<think>'),
        contentChunk('reasoning here'),
        contentChunk('</think>'),
        contentChunk('answer'),
      ])

      const types = events.map((e) => e.type)
      expect(types).toEqual([
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'content_delta',
      ])
      expect((events[1] as any).content).toBe('reasoning here')
      expect((events[3] as any).content).toBe('answer')
    })

    it('handles think open and close in same chunk', () => {
      const events = processAll([
        contentChunk('<think>reasoning</think>answer'),
      ])

      const types = events.map((e) => e.type)
      expect(types).toEqual([
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'content_delta',
      ])
    })

    it('buffers initial content to detect <think> tag', () => {
      // Short first chunk that could be start of <think>
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      const first = normalizer.processChunk(contentChunk('<th'), preprocessor)
      // Should buffer, not emit yet
      expect(first).toEqual([])

      const second = normalizer.processChunk(
        contentChunk('ink>thoughts'),
        preprocessor,
      )
      const types = second.map((e) => e.type)
      expect(types).toContain('thinking_start')
    })

    it('flushes buffered content as plain text when no think tag found', () => {
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      normalizer.processChunk(contentChunk('hi'), preprocessor)
      // Buffer is only 2 chars, still under threshold (5)
      const second = normalizer.processChunk(
        contentChunk(' there, world'),
        preprocessor,
      )
      // Now buffer exceeds 5 chars, should flush as content
      expect(second.some((e) => e.type === 'content_delta')).toBe(true)
    })

    it('flushes open thinking on stream end', () => {
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      normalizer.processChunk(
        contentChunk('<think>still thinking'),
        preprocessor,
      )
      const tail = normalizer.flush()
      expect(tail.some((e) => e.type === 'thinking_end')).toBe(true)
    })

    it('drops whitespace-only content after </think>', () => {
      const events = processAll([contentChunk('<think>thought</think>  \n  ')])
      // Should have thinking_start, thinking_delta, thinking_end but no content_delta
      const types = events.map((e) => e.type)
      expect(types).not.toContain('content_delta')
    })
  })

  describe('reasoning_content format (OpenAI-style)', () => {
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

    it('handles interleaved reasoning and content', () => {
      const events = processAll([
        reasoningChunk('thought1'),
        reasoningChunk('', 'partial answer'),
        reasoningChunk('thought2'),
        { choices: [{ delta: { content: 'final' } }] },
      ])

      const types = events.map((e) => e.type)
      // Should see: start, delta, end, content, start, delta, end, content
      expect(types[0]).toBe('thinking_start')
      expect(types).toContain('content_delta')
      expect(types.filter((t) => t === 'thinking_start').length).toBe(2)
    })

    it('handles reasoning with empty string (present but empty)', () => {
      const chunk = {
        choices: [{ delta: { reasoning_content: '' } }],
      }
      const events = processAll([chunk, reasoningChunk('actual thought')])
      // First chunk has reasoning_content present (not null), so enters reasoning format
      const types = events.map((e) => e.type)
      expect(types[0]).toBe('thinking_start')
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

    it('does not restart thinking for whitespace-only reasoning tails after content started', () => {
      const events = processAll([
        reasoningChunk('thinking...'),
        {
          choices: [{ delta: { reasoning_content: '. ', content: 'It' } }],
        },
        {
          choices: [{ delta: { reasoning_content: ' ', content: '’s clear' } }],
        },
        { choices: [{ delta: { content: ' and polite.' } }] },
      ])

      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === 'thinking_start').length).toBe(1)
      const text = events
        .filter((e) => e.type === 'content_delta')
        .map((e) => (e as any).content)
        .join('')
      expect(text).toBe('It’s clear and polite.')
    })

    it('still restarts thinking when substantive reasoning resumes after content', () => {
      const events = processAll([
        reasoningChunk('thought1'),
        { choices: [{ delta: { content: 'partial answer' } }] },
        reasoningChunk('thought2'),
        { choices: [{ delta: { content: 'final' } }] },
      ])

      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === 'thinking_start').length).toBe(2)
      expect(types.filter((t) => t === 'thinking_end').length).toBe(2)
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

      expect(events).toContainEqual({
        type: 'content_delta',
        content: ' NAD+ is important.',
      })
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
        contentChunk('<think>thinking'),
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'searching',
          action: { query: 'q' },
        },
      ])

      const types = events.map((e) => e.type)
      const thinkEndIdx = types.indexOf('thinking_end')
      const searchIdx = types.indexOf('web_search')
      expect(thinkEndIdx).toBeLessThan(searchIdx)
    })
  })

  describe('flush', () => {
    it('flushes small buffered content when stream ends early', () => {
      const normalizer = createEventNormalizer()
      const preprocessor = createContentPreprocessor()

      normalizer.processChunk(contentChunk('hi'), preprocessor)
      const tail = normalizer.flush()
      expect(tail).toContainEqual({ type: 'content_delta', content: 'hi' })
    })

    it('returns empty when nothing buffered', () => {
      const normalizer = createEventNormalizer()
      expect(normalizer.flush()).toEqual([])
    })
  })
})
