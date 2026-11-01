import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_THEME_MODE,
  SETTINGS_THINKING_ENABLED,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import { loadLocalProfile, turnProfile } from '@/services/harness/local-profile'
import { getView } from '@/services/harness/runtime'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

describe('loadLocalProfile', () => {
  it('imports the previous client’s settings once', () => {
    localStorage.setItem(USER_PREFS_NICKNAME, 'Sam')
    localStorage.setItem(USER_PREFS_TRAITS, '["direct","witty"]')
    localStorage.setItem(USER_PREFS_PERSONALIZATION_ENABLED, 'false')
    localStorage.setItem(SETTINGS_REASONING_EFFORT, 'high')
    localStorage.setItem(SETTINGS_THINKING_ENABLED, 'false')
    localStorage.setItem(SETTINGS_THEME_MODE, 'dark')
    localStorage.setItem(SETTINGS_CHAT_FONT, 'comic')
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, 'p1')
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([
        {
          id: 'p1',
          name: 'Editor',
          description: 'Edits',
          systemPrompt: 'Edit text.',
          createdAt: 1,
          updatedAt: 2,
          model: 'deep-model',
          webSearchEnabled: true,
        },
      ]),
    )
    const imported = {
      nickname: 'Sam',
      traits: ['direct', 'witty'],
      isUsingPersonalization: false,
      reasoningEffort: 'high',
      thinkingEnabled: false,
      themeMode: 'dark',
      defaultPromptPresetId: 'p1',
      customPromptPresets: [
        {
          id: 'p1',
          name: 'Editor',
          description: 'Edits',
          systemPrompt: 'Edit text.',
          createdAt: 1,
          updatedAt: 2,
          model: 'deep-model',
          webSearchEnabled: true,
        },
      ],
    }

    expect(loadLocalProfile()).toEqual(imported)
    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      imported,
    )

    localStorage.setItem(USER_PREFS_NICKNAME, 'Changed by the old client')
    expect(loadLocalProfile().nickname).toBe('Sam')
  })

  it.each([
    { id: 'p1', name: '' },
    { id: 'p1', name: 'Editor', webSearchEnabled: 'yes' },
  ])('drops presets the harness would refuse: %j', (preset) => {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([preset]),
    )
    expect(loadLocalProfile()).toEqual({})
    expect(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)).toBeNull()
  })
})

describe('turnProfile', () => {
  it('sends only valid prompt settings', () => {
    expect(
      turnProfile({
        nickname: 'Sam',
        language: 'French',
        traits: ['direct', 3],
        reasoningEffort: 'extreme',
        autoIntelligence: 'max',
        thinkingEnabled: 'yes',
        webSearchEnabled: false,
        sandboxEnabled: true,
        themeMode: 'dark',
        hasSeenOnboarding: true,
      }),
    ).toEqual({
      nickname: 'Sam',
      language: 'French',
      autoIntelligence: 'max',
      webSearchEnabled: false,
    })
  })
})

describe('profile storage modes', () => {
  it('keeps the settings of an account without cloud sync in local storage', async () => {
    localStorage.setItem(
      USER_PREFS_LOCAL_PROFILE,
      JSON.stringify({ nickname: 'Local Sam' }),
    )
    const api = signIn()

    await api.refreshProfile()
    expect(getView()).toMatchObject({
      profile: { nickname: 'Local Sam' },
      keyReady: false,
      profileReady: true,
    })

    await api.updateProfile({ language: 'German' })

    expect(client.post).not.toHaveBeenCalled()
    expect(getView().profile).toEqual({
      nickname: 'Local Sam',
      language: 'German',
    })
    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      { nickname: 'Local Sam', language: 'German' },
    )
  })

  it('reads a cloud account’s settings from the harness and keeps them when sync is turned off', async () => {
    localStorage.setItem(
      USER_PREFS_LOCAL_PROFILE,
      JSON.stringify({ nickname: 'Stale' }),
    )
    const api = signIn({ cloud: true })
    client.post.mockResolvedValue({ nickname: 'Cloud Sam', language: 'Dutch' })

    await api.refreshProfile()
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/profile/get',
      { key: KEY },
      expect.any(AbortSignal),
    )
    expect(getView()).toMatchObject({
      profile: { nickname: 'Cloud Sam', language: 'Dutch' },
      keyReady: true,
      profileReady: true,
    })

    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'false')
    await api.storageModeChanged()

    expect(client.post).toHaveBeenCalledTimes(1)
    expect(getView()).toMatchObject({
      profile: { nickname: 'Cloud Sam', language: 'Dutch' },
      keyReady: false,
      profileReady: true,
    })
    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      { nickname: 'Cloud Sam', language: 'Dutch' },
    )
  })
})
