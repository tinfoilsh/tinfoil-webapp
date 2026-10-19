import { ensureValidISODate } from '@/utils/chat-timestamps'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('chat-timestamps', () => {
  describe('ensureValidISODate', () => {
    let mockNow: Date

    beforeEach(() => {
      mockNow = new Date('2024-06-15T12:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(mockNow)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it.each(['999999999999999999_x', '-999999999999999999_x'])(
      'falls back to the clock for an out-of-range reverse ID %s',
      (id) => {
        expect(ensureValidISODate(undefined, id)).toBe(
          '2024-06-15T12:00:00.000Z',
        )
      },
    )

    it.each([
      new Date('2024-01-01T00:00:00.000Z'),
      '2024-01-01T00:00:00.000Z',
      1704067200000,
    ])('normalizes accepted date representations: %s', (value) => {
      expect(ensureValidISODate(value, '9999999999999_other')).toBe(
        '2024-01-01T00:00:00.000Z',
      )
    })

    it.each([
      [undefined, '8295932799999_abc123'],
      [undefined, '8295932799999'],
      ['invalid-date', '8295932799999_abc123'],
    ])('uses reverse-ID fallback for %s with %s', (value, id) => {
      expect(ensureValidISODate(value, id)).toBe('2024-01-01T00:00:00.000Z')
    })

    it.each([
      [undefined, undefined],
      [null, undefined],
      [undefined, ''],
      [undefined, 'abc_123'],
      [undefined, 'invalid_id'],
    ])(
      'uses clock fallback for missing or invalid sources: %s, %s',
      (value, id) => {
        expect(ensureValidISODate(value, id)).toBe('2024-06-15T12:00:00.000Z')
      },
    )
  })
})
