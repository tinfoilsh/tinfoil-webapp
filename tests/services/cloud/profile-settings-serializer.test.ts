import {
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import {
  applySettingsToLocal,
  loadLocalSettings,
} from '@/services/cloud/profile-settings-serializer'
import { beforeEach, describe, expect, it } from 'vitest'

describe('profile-settings-serializer', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves empty local personalization values for syncing clears', () => {
    localStorage.setItem(USER_PREFS_NICKNAME, '')
    localStorage.setItem(USER_PREFS_PROFESSION, '')
    localStorage.setItem(USER_PREFS_TRAITS, JSON.stringify([]))
    localStorage.setItem(USER_PREFS_ADDITIONAL_CONTEXT, '')
    localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, '')
    localStorage.setItem(USER_PREFS_PERSONALIZATION_ENABLED, 'false')

    expect(loadLocalSettings()).toMatchObject({
      nickname: '',
      profession: '',
      traits: [],
      additionalContext: '',
      customSystemPrompt: '',
      isUsingPersonalization: false,
    })
  })

  it('clears local personalization fields when the remote profile omits them', () => {
    localStorage.setItem(USER_PREFS_NICKNAME, 'old')
    localStorage.setItem(USER_PREFS_PROFESSION, 'old job')
    localStorage.setItem(USER_PREFS_TRAITS, JSON.stringify(['concise']))
    localStorage.setItem(USER_PREFS_ADDITIONAL_CONTEXT, 'old context')
    localStorage.setItem(USER_PREFS_PERSONALIZATION_ENABLED, 'true')

    applySettingsToLocal({ isUsingPersonalization: false })

    expect(localStorage.getItem(USER_PREFS_NICKNAME)).toBe('')
    expect(localStorage.getItem(USER_PREFS_PROFESSION)).toBe('')
    expect(localStorage.getItem(USER_PREFS_TRAITS)).toBe('[]')
    expect(localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT)).toBe('')
    expect(localStorage.getItem(USER_PREFS_PERSONALIZATION_ENABLED)).toBe(
      'false',
    )
  })
})
