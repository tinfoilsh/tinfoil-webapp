import { formatElapsed } from '@/components/chat/renderers/components/format-duration'
import { describe, expect, it } from 'vitest'

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [8.9, '8s'],
    [59.99, '59s'],
    [60, '1m'],
    [213, '3m 33s'],
    [3_599, '59m 59s'],
    [3_600, '1h'],
    [3_845, '1h 4m'],
    [-2, '0s'],
  ])('shows %s seconds as %s', (seconds, label) => {
    expect(formatElapsed(seconds)).toBe(label)
  })
})
