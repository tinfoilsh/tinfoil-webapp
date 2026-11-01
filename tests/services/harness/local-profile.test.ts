import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_THEME_MODE,
  SETTINGS_THINKING_ENABLED,
  SETTINGS_WEB_SEARCH_AVAILABLE,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_LOCAL_PROFILE_UPGRADED,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import { loadLocalProfile } from '@/services/harness/local-profile'
import { useHarness } from '@/services/harness/provider'
import { getView } from '@/services/harness/runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'

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
    localStorage.setItem(SETTINGS_WEB_SEARCH_AVAILABLE, 'false')
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
      webSearchAvailable: false,
      themeMode: 'dark',
      chatFont: 'comic',
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
})

describe('profile storage modes', () => {
  it('keeps the settings of an account without cloud sync in local storage', async () => {
    localStorage.setItem(
      USER_PREFS_LOCAL_PROFILE,
      JSON.stringify({ nickname: 'Local Sam' }),
    )
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
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

  it("shows the session's defaults for settings a profile leaves unset", () => {
    signIn({
      session: {
        ...testSession,
        profileDefaults: { piiCheckEnabled: true, genUIEnabled: true },
      },
      profile: { genUIEnabled: false },
    })

    const { result } = renderHook(() => useHarness().profile)

    expect(result.current).toEqual({
      piiCheckEnabled: true,
      genUIEnabled: false,
    })
    expect(getView().profile).toEqual({ genUIEnabled: false })
  })

  it('upgrades the settings kept on this device through the harness once', async () => {
    const stored = {
      isUsingCustomPrompt: true,
      customSystemPrompt: 'Answer in French.',
    }
    const upgraded = {
      isUsingCustomPrompt: false,
      customSystemPrompt: '',
      defaultPromptPresetId: 'user:migrated-custom-prompt',
      customPromptPresets: [
        {
          id: 'user:migrated-custom-prompt',
          name: 'My default prompt',
          systemPrompt: 'Answer in French.',
        },
      ],
    }
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE, JSON.stringify(stored))
    const api = signIn()
    client.post.mockResolvedValueOnce({ profile: upgraded })

    await api.refreshProfile()

    expect(getView().profile).toEqual(upgraded)
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/profile/upgrade',
      { profile: stored },
      expect.any(AbortSignal),
    )
    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      upgraded,
    )
    expect(localStorage.getItem(USER_PREFS_LOCAL_PROFILE_UPGRADED)).toBe('true')

    await api.refreshProfile()
    expect(client.post).toHaveBeenCalledTimes(1)
  })

  it('upgrades settings changed during an upgrade on a later load', async () => {
    localStorage.setItem(
      USER_PREFS_LOCAL_PROFILE,
      JSON.stringify({ nickname: 'Sam' }),
    )
    const api = signIn()
    let answer!: (value: unknown) => void
    client.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const refreshing = api.refreshProfile()
    await vi.waitFor(() => expect(client.post).toHaveBeenCalledTimes(1))
    await api.updateProfile({ language: 'German' })

    answer({ profile: { nickname: 'Sam', themeMode: 'system' } })
    await refreshing

    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      { nickname: 'Sam', language: 'German' },
    )
    expect(localStorage.getItem(USER_PREFS_LOCAL_PROFILE_UPGRADED)).toBeNull()
    const upgraded = {
      nickname: 'Sam',
      language: 'German',
      themeMode: 'system',
    }
    client.post.mockResolvedValueOnce({ profile: upgraded })

    await api.refreshProfile()

    expect(client.post).toHaveBeenCalledTimes(2)
    expect(client.post).toHaveBeenLastCalledWith(
      '/v1/profile/upgrade',
      { profile: { nickname: 'Sam', language: 'German' } },
      expect.any(AbortSignal),
    )
    expect(getView().profile).toEqual(upgraded)
    expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual(
      upgraded,
    )
    expect(localStorage.getItem(USER_PREFS_LOCAL_PROFILE_UPGRADED)).toBe('true')
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
