import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_SELECTED_MODEL,
  SETTINGS_THINKING_ENABLED,
  SETTINGS_WEB_SEARCH_AVAILABLE,
  SETTINGS_WEB_SEARCH_ENABLED,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_PROJECT_UPLOAD,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import {
  applySettingsToLocal,
  hasProfileChanged,
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

  it('keeps unspecified personalization fields intact on partial remote updates', () => {
    localStorage.setItem(USER_PREFS_NICKNAME, 'Alice')
    localStorage.setItem(USER_PREFS_PROFESSION, 'Dev')
    localStorage.setItem(USER_PREFS_TRAITS, JSON.stringify(['concise']))
    localStorage.setItem(USER_PREFS_ADDITIONAL_CONTEXT, 'context')
    localStorage.setItem(USER_PREFS_PERSONALIZATION_ENABLED, 'true')

    applySettingsToLocal({ nickname: 'Bob' })

    expect(localStorage.getItem(USER_PREFS_NICKNAME)).toBe('Bob')
    expect(localStorage.getItem(USER_PREFS_PROFESSION)).toBe('Dev')
    expect(localStorage.getItem(USER_PREFS_TRAITS)).toBe(
      JSON.stringify(['concise']),
    )
    expect(localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT)).toBe('context')
    expect(localStorage.getItem(USER_PREFS_PERSONALIZATION_ENABLED)).toBe(
      'true',
    )
  })

  it('clears explicitly emptied personalization fields', () => {
    localStorage.setItem(USER_PREFS_NICKNAME, 'Alice')

    applySettingsToLocal({ nickname: '', isUsingPersonalization: false })

    expect(localStorage.getItem(USER_PREFS_NICKNAME)).toBe('')
    expect(localStorage.getItem(USER_PREFS_PERSONALIZATION_ENABLED)).toBe(
      'false',
    )
  })

  it('round-trips custom prompt presets and shared chat defaults', () => {
    const presets = [
      {
        id: 'user:abc',
        name: 'Reviewer',
        description: 'Review code',
        systemPrompt: '<system>\nReview carefully.\n</system>',
        createdAt: 1,
        updatedAt: 2,
      },
    ]

    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify(presets),
    )
    localStorage.setItem(
      USER_PREFS_FAVORITE_PROMPT_PRESETS,
      JSON.stringify(['builtin:tutor', 'user:abc']),
    )
    localStorage.setItem(SETTINGS_SELECTED_MODEL, 'gpt-oss-120b')
    localStorage.setItem(SETTINGS_REASONING_EFFORT, 'high')
    localStorage.setItem(SETTINGS_THINKING_ENABLED, 'false')
    localStorage.setItem(SETTINGS_WEB_SEARCH_ENABLED, 'false')
    localStorage.setItem(SETTINGS_WEB_SEARCH_AVAILABLE, 'false')
    localStorage.setItem(SETTINGS_CODE_EXECUTION_ENABLED, 'true')
    localStorage.setItem(SETTINGS_PII_CHECK_ENABLED, 'false')
    localStorage.setItem(SETTINGS_CHAT_FONT, 'mono')
    localStorage.setItem(USER_PREFS_PROJECT_UPLOAD, 'project')

    const loaded = loadLocalSettings()
    expect('selectedModel' in loaded).toBe(false)
    expect(loaded).toMatchObject({
      customPromptPresets: presets,
      favoritePromptPresetIds: ['builtin:tutor', 'user:abc'],
      reasoningEffort: 'high',
      thinkingEnabled: false,
      webSearchEnabled: false,
      webSearchAvailable: false,
      codeExecutionEnabled: true,
      piiCheckEnabled: false,
      chatFont: 'mono',
      projectUploadPreference: 'project',
    })
  })

  it('does not report a phantom change after adopting a themeMode-less remote', () => {
    // A peer (iOS) sends isDarkMode but never themeMode. Applying it
    // derives themeMode locally, so the raw remote no longer matches
    // what this client would re-serialize.
    const remote = {
      isDarkMode: true,
      nickname: 'Alice',
      favoritePromptPresetIds: ['builtin:tutor'],
    }

    applySettingsToLocal(remote)

    // The baseline the sync layer must store is the round-tripped local
    // snapshot, not the raw remote.
    const baseline = loadLocalSettings()
    const current = loadLocalSettings()

    // Comparing against the raw remote falsely looks dirty (the
    // themeMode this client derived is absent from the remote), which is
    // exactly what wedged pulls and looped STALE_BLOB pushes.
    expect(hasProfileChanged(current, remote)).toBe(true)

    // Comparing against the round-tripped baseline converges: no phantom
    // local change, so the dirty flag clears and pulls are not blocked.
    expect(hasProfileChanged(current, baseline)).toBe(false)
  })

  it('applies synced prompt presets and shared chat defaults locally', () => {
    const presets = [
      {
        id: 'user:def',
        name: 'Tutor',
        description: 'Teach concepts',
        systemPrompt: '<system>\nTeach.\n</system>',
        createdAt: 3,
        updatedAt: 4,
      },
    ]

    applySettingsToLocal({
      customPromptPresets: presets,
      favoritePromptPresetIds: ['builtin:translator', 'user:def'],
      reasoningEffort: 'low',
      thinkingEnabled: true,
      webSearchEnabled: true,
      webSearchAvailable: false,
      codeExecutionEnabled: false,
      piiCheckEnabled: true,
      chatFont: 'serif',
      projectUploadPreference: 'chat',
    })

    expect(localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)).toBe(
      JSON.stringify(presets),
    )
    expect(localStorage.getItem(USER_PREFS_FAVORITE_PROMPT_PRESETS)).toBe(
      JSON.stringify(['builtin:translator', 'user:def']),
    )
    expect(localStorage.getItem(SETTINGS_SELECTED_MODEL)).toBeNull()
    expect(localStorage.getItem(SETTINGS_REASONING_EFFORT)).toBe('low')
    expect(localStorage.getItem(SETTINGS_THINKING_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_WEB_SEARCH_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_WEB_SEARCH_AVAILABLE)).toBe('false')
    expect(localStorage.getItem(SETTINGS_CODE_EXECUTION_ENABLED)).toBe('false')
    expect(localStorage.getItem(SETTINGS_PII_CHECK_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_CHAT_FONT)).toBe('serif')
    expect(localStorage.getItem(USER_PREFS_PROJECT_UPLOAD)).toBe('chat')
  })

  it('defaults web search availability to on', () => {
    expect(loadLocalSettings().webSearchAvailable).toBe(true)
  })
})
