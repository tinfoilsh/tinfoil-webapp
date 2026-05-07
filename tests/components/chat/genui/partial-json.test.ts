import { tryParsePartialJson } from '@/components/chat/genui/partial-json'
import { describe, expect, it } from 'vitest'

describe('tryParsePartialJson', () => {
  it('parses well-formed JSON without modification', () => {
    expect(tryParsePartialJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('returns null for empty input', () => {
    expect(tryParsePartialJson('')).toBeNull()
    expect(tryParsePartialJson('   ')).toBeNull()
  })

  it('recovers an unterminated string value', () => {
    const result = tryParsePartialJson('{"title":"My Slid')
    expect(result).toEqual({ title: 'My Slid' })
  })

  it('recovers a missing closing brace', () => {
    const result = tryParsePartialJson('{"a":1,"b":2')
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('drops a trailing dangling key', () => {
    const result = tryParsePartialJson('{"title":"Demo","desc')
    expect(result).toEqual({ title: 'Demo' })
  })

  it('recovers a partial nested object', () => {
    const result = tryParsePartialJson(
      '{"title":"Demo","source":{"type":"html","html":"<h1',
    )
    expect(result).toEqual({
      title: 'Demo',
      source: { type: 'html', html: '<h1' },
    })
  })

  it('recovers from a stream that ends in an open array', () => {
    const result = tryParsePartialJson('{"items":[1,2,3')
    expect(result).toEqual({ items: [1, 2, 3] })
  })

  it('strips a trailing comma after the last element', () => {
    const result = tryParsePartialJson('{"a":1,')
    expect(result).toEqual({ a: 1 })
  })
})
