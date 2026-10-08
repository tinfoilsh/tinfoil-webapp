import {
  clearPersonalizationDetails,
  isPersonalizationEnabled,
} from '@/utils/personalization-settings'
import { describe, expect, it } from 'vitest'

describe('personalization settings', () => {
  it.each([
    [null, true],
    ['true', true],
    ['false', false],
    ['', true],
    ['unknown', true],
  ] as const)('enables personalization for %s: %s', (value, expected) => {
    expect(isPersonalizationEnabled(value)).toBe(expected)
  })

  it('clears details without changing the toggle or language', () => {
    expect(
      clearPersonalizationDetails({
        nickname: 'Ada',
        profession: 'Engineer',
        traits: ['direct'],
        additionalContext: 'Use examples',
        language: 'Welsh',
        isEnabled: false,
      }),
    ).toEqual({
      nickname: '',
      profession: '',
      traits: [],
      additionalContext: '',
      language: 'Welsh',
      isEnabled: false,
    })
  })
})
