import {
  clearPersonalizationDetails,
  isPersonalizationEnabled,
} from '@/utils/personalization-settings'
import { describe, expect, it } from 'vitest'

describe('personalization settings', () => {
  it('defaults missing and enabled flags to on', () => {
    expect(isPersonalizationEnabled(null)).toBe(true)
    expect(isPersonalizationEnabled('true')).toBe(true)
  })

  it('treats only explicit false as off', () => {
    expect(isPersonalizationEnabled('false')).toBe(false)
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
