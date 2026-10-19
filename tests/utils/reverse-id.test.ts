import { generateReverseId } from '@/utils/reverse-id'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('generateReverseId', () => {
  afterEach(() => vi.useRealTimers())
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
