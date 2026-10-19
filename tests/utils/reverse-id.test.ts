import { generateReverseId } from '@/utils/reverse-id'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('generateReverseId', () => {
  afterEach(() => vi.useRealTimers())
  it.each([
    [0, 9999999999999, '9999999999999'],
    [1704067200000, 8295932799999, '8295932799999'],
    [9999999999990, 9, '0000000000009'],
  ] as const)(
    'generates a padded reverse timestamp and UUID for %s',
    (timestamp, expected, prefix) => {
      const { id, reverseTimestamp, createdAtMs } = generateReverseId(timestamp)
      expect(createdAtMs).toBe(timestamp)
      expect(reverseTimestamp).toBe(expected)

      const [ts, uuid] = id.split('_')
      expect(ts).toBe(prefix)
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    },
  )

  it('reverseTimestamp decreases as time increases', () => {
    const a = generateReverseId(9999999999989)
    const b = generateReverseId(9999999999990)
    expect(a.reverseTimestamp).toBe(10)
    expect(b.reverseTimestamp).toBe(9)
    expect(b.reverseTimestamp).toBeLessThan(a.reverseTimestamp)
    expect([a.id, b.id].sort()).toEqual([b.id, a.id])
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    expect(generateReverseId()).toMatchObject({
      createdAtMs: 1704067200000,
      reverseTimestamp: 8295932799999,
    })
  })
})
