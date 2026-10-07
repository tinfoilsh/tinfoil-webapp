import {
  TINFOIL_WEB_SEARCH_CALL_TYPE,
  createTinfoilEventParser,
} from '@/utils/tinfoil-events'
import { describe, expect, it } from 'vitest'

function markerFor(payload: Record<string, unknown>): string {
  return `<tinfoil-event>${JSON.stringify(payload)}</tinfoil-event>`
}

describe('createTinfoilEventParser', () => {
  it('removes marker padding identically at every chunk boundary', () => {
    const payload = { type: TINFOIL_WEB_SEARCH_CALL_TYPE, status: 'completed' }
    const input = `hello\n${markerFor(payload)}\nAnswer.`
    for (let split = 0; split <= input.length; split++) {
      const parser = createTinfoilEventParser()
      const first = parser.consume(input.slice(0, split))
      const empty = parser.consume('')
      const second = parser.consume(input.slice(split))
      expect(first.text + empty.text + second.text + parser.flush()).toBe(
        'helloAnswer.',
      )
      expect([...first.events, ...empty.events, ...second.events]).toEqual([
        payload,
      ])
    }
  })
  it.each([
    ['prefix ', ' suffix', 'prefix  suffix'],
    ['\n', '\nAnswer.', 'Answer.'],
  ])(
    'extracts a marker delivered in a single chunk: %j',
    (prefix, suffix, expected) => {
      const parser = createTinfoilEventParser()
      const payload = {
        type: TINFOIL_WEB_SEARCH_CALL_TYPE,
        item_id: 'ws_1',
        status: 'in_progress',
        action: { type: 'search', query: 'q' },
      }
      const input = `${prefix}${markerFor(payload)}${suffix}`
      const result = parser.consume(input)
      expect(result.text).toBe(expected)
      expect(result.events).toHaveLength(1)
      expect(result.events[0].status).toBe('in_progress')
      expect(result.events[0]).toMatchObject({ action: { query: 'q' } })
      expect(parser.flush()).toBe('')
    },
  )

  it('preserves per-search sources attached to a marker payload', () => {
    const parser = createTinfoilEventParser()
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'q' },
      sources: [
        {
          title: 'Example',
          url: 'https://example.com/article',
        },
      ],
    }
    const result = parser.consume(markerFor(payload))
    expect(result.events).toHaveLength(1)
    const event = result.events[0]
    if (event.type !== TINFOIL_WEB_SEARCH_CALL_TYPE)
      throw new Error('Expected web search event')
    expect(event.sources).toEqual(payload.sources)
  })

  it('stitches a marker split across an arbitrary byte boundary', () => {
    const parser = createTinfoilEventParser()
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'hello world' },
    }
    const full = markerFor(payload)
    // Split every single character — the parser must hold state across
    // every boundary, including mid-tag, mid-JSON, and mid-close-tag.
    const out: string[] = []
    const events = []
    for (const ch of full) {
      const r = parser.consume(ch)
      out.push(r.text)
      events.push(...r.events)
    }
    out.push(parser.flush())
    expect(out.join('')).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('completed')
  })

  it('does not emit a trailing partial open tag as visible text', () => {
    const parser = createTinfoilEventParser()
    // The suffix `<tinfoil-` could grow into a real open tag; the
    // parser must hold it back rather than leak it to the UI.
    const result = parser.consume('hello <tinfoil-')
    expect(result.text).toBe('hello ')
    expect(result.events).toEqual([])
    // Completing the tag + payload emits the event, still suppressing
    // the raw tags from the visible text.
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'q' },
    }
    const rest = `event>${JSON.stringify(payload)}</tinfoil-event>tail`
    const second = parser.consume(rest)
    expect(second.text).toBe('tail')
    expect(second.events).toHaveLength(1)
  })

  it('handles multiple markers in one chunk with surrounding text', () => {
    const parser = createTinfoilEventParser()
    const a = markerFor({
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'in_progress',
      action: { type: 'search', query: 'a' },
    })
    const b = markerFor({
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'a' },
    })
    const result = parser.consume(`L${a}M${b}R`)
    expect(result.text).toBe('LMR')
    expect(result.events.map((e) => e.status)).toEqual([
      'in_progress',
      'completed',
    ])
  })

  it('drops malformed JSON payloads without breaking later markers', () => {
    const parser = createTinfoilEventParser()
    const malformed = '<tinfoil-event>{not json}</tinfoil-event>'
    const good = markerFor({
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_2',
      status: 'completed',
      action: { type: 'search', query: 'q' },
    })
    const result = parser.consume(`${malformed}keep${good}`)
    expect(result.text).toBe('keep')
    expect(result.events).toHaveLength(1)
    expect(result.events[0].item_id).toBe('ws_2')
  })

  it('ignores foreign JSON payloads that are not tinfoil.web_search_call', () => {
    const parser = createTinfoilEventParser()
    const foreign =
      '<tinfoil-event>{"type":"other.kind","status":"completed"}</tinfoil-event>'
    const result = parser.consume(foreign)
    expect(result.text).toBe('')
    expect(result.events).toEqual([])
  })

  it('flushes unterminated marker body without leaking the open tag', () => {
    const parser = createTinfoilEventParser()
    const first = parser.consume('hello <tinfoil-event>{"type":"')
    // The chunk before the opening tag flows through verbatim.
    expect(first.text).toBe('hello ')
    // Stream ends mid-marker; the parser already consumed the opening
    // tag and entered the marker body, so the flushed tail surfaces
    // only the uninterpreted JSON fragment. The opening tag itself
    // stays suppressed so the UI never renders raw `<tinfoil-event>`.
    const tail = parser.flush()
    expect(tail).not.toContain('<tinfoil-event>')
    expect(tail).toBe('{"type":"')
  })

  it('strips trailing pad newline that arrives in the next chunk', () => {
    const parser = createTinfoilEventParser()
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'q' },
    }
    // Close tag lands at the exact end of chunk 1; the router's
    // trailing pad `\n` arrives at the start of chunk 2. Both must be
    // suppressed so the concatenated text has no orphan blank line.
    const first = parser.consume(`hello\n${markerFor(payload)}`)
    expect(first.text).toBe('hello')
    expect(first.events).toHaveLength(1)
    const second = parser.consume('\nAnswer.')
    expect(second.text).toBe('Answer.')
    expect(second.events).toEqual([])
  })

  it('strips leading pad newline when the open tag starts the next chunk', () => {
    const parser = createTinfoilEventParser()
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'in_progress',
      action: { type: 'search', query: 'q' },
    }
    // Leading pad `\n` is in chunk 1 before the open tag arrives in
    // chunk 2. The parser must retroactively drop it from the emitted
    // text so no orphan blank line surfaces above the marker.
    const first = parser.consume('hello\n')
    expect(first.text).toBe('hello')
    const second = parser.consume(`${markerFor(payload)}\nAnswer.`)
    expect(second.text).toBe('Answer.')
    expect(second.events).toHaveLength(1)
    expect(first.text + second.text + parser.flush()).toBe('helloAnswer.')
  })

  it.each([
    ['line1\n', 'line2', 'line1\nline2'],
    ['plain answer without events', '', 'plain answer without events'],
    ['trailing\n', '', 'trailing\n'],
  ])(
    'preserves model text without markers across chunks: %j',
    (start, end, expected) => {
      const parser = createTinfoilEventParser()
      // A `\n` emitted by the model that is NOT followed by an open tag
      // in the next chunk must survive verbatim.
      const first = parser.consume(start)
      const second = parser.consume(end)
      expect(first.events).toEqual([])
      expect(second.events).toEqual([])
      expect(first.text + second.text + parser.flush()).toBe(expected)
    },
  )
})

describe('marker whitespace', () => {
  it('preserves non-pad whitespace adjacent to a marker', () => {
    const payload = {
      type: TINFOIL_WEB_SEARCH_CALL_TYPE,
      item_id: 'ws_1',
      status: 'completed',
      action: { type: 'search', query: 'q' },
    }
    // Two `\n` before the marker: one is consumed as the pad, the
    // other is real content the model intended to emit.
    const input = `first\n\n${markerFor(payload)}\n\nsecond`
    for (let split = 0; split <= input.length; split++) {
      const parser = createTinfoilEventParser()
      const first = parser.consume(input.slice(0, split))
      const second = parser.consume(input.slice(split))
      expect(first.text + second.text + parser.flush()).toBe('first\n\nsecond')
    }
  })
})
