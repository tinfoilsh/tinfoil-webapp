import { chatActivityTime, ensureValidISODate } from '@/utils/chat-timestamps'
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

  // These cases mirror the sync enclave's chatActivityAt so the client
  // and the server order chats the same way.
  describe('chatActivityTime', () => {
    it.each([
      {
        name: 'newest message wins over creation',
        chat: {
          createdAt: '2025-01-01T00:00:00.000Z',
          messages: [
            { timestamp: '2025-03-01T10:00:00.000Z' },
            { timestamp: new Date('2025-02-01T10:00:00.000Z') },
          ],
        },
        want: '2025-03-01T10:00:00.000Z',
      },
      {
        name: 'creation wins when it is later, as for a fork',
        chat: {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          messages: [{ timestamp: '2025-03-01T10:00:00Z' }],
        },
        want: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'offsets and fractional seconds compare as instants',
        chat: {
          createdAt: '2025-01-01T00:00:00Z',
          messages: [
            { timestamp: '2025-03-01T12:00:00.5+02:00' },
            { timestamp: '2025-03-01T10:00:00.25Z' },
          ],
        },
        want: '2025-03-01T10:00:00.500Z',
      },
      {
        name: 'unparseable timestamps are ignored',
        chat: {
          createdAt: '2025-01-01T00:00:00Z',
          messages: [{ timestamp: 'yesterday' }, {}],
        },
        want: '2025-01-01T00:00:00.000Z',
      },
      {
        name: 'a summary row uses the activity recorded with it',
        chat: {
          createdAt: '2025-01-01T00:00:00Z',
          messages: [],
          isMetadataOnly: true,
          activityAt: '2025-04-01T00:00:00.000Z',
        },
        want: '2025-04-01T00:00:00.000Z',
      },
    ])('$name', ({ chat, want }) => {
      expect(new Date(chatActivityTime(chat)).toISOString()).toBe(want)
    })
  })
})
