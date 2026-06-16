import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_SELECTED_MODEL,
  SETTINGS_THINKING_ENABLED,
  SETTINGS_WEB_SEARCH_ENABLED,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_PROJECT_UPLOAD,
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
    localStorage.setItem(SETTINGS_SELECTED_MODEL, 'gpt-oss-120b')
    localStorage.setItem(SETTINGS_REASONING_EFFORT, 'high')
    localStorage.setItem(SETTINGS_THINKING_ENABLED, 'false')
    localStorage.setItem(SETTINGS_WEB_SEARCH_ENABLED, 'false')
    localStorage.setItem(SETTINGS_CODE_EXECUTION_ENABLED, 'true')
    localStorage.setItem(SETTINGS_PII_CHECK_ENABLED, 'false')
    localStorage.setItem(SETTINGS_CHAT_FONT, 'mono')
    localStorage.setItem(USER_PREFS_PROJECT_UPLOAD, 'project')

    expect(loadLocalSettings()).toMatchObject({
      customPromptPresets: presets,
      selectedModel: 'gpt-oss-120b',
      reasoningEffort: 'high',
      thinkingEnabled: false,
      webSearchEnabled: false,
      codeExecutionEnabled: true,
      piiCheckEnabled: false,
      chatFont: 'mono',
      projectUploadPreference: 'project',
    })
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
      selectedModel: 'gpt-oss-120b',
      reasoningEffort: 'low',
      thinkingEnabled: true,
      webSearchEnabled: true,
      codeExecutionEnabled: false,
      piiCheckEnabled: true,
      chatFont: 'serif',
      projectUploadPreference: 'chat',
    })

    expect(localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)).toBe(
      JSON.stringify(presets),
    )
    expect(localStorage.getItem(SETTINGS_SELECTED_MODEL)).toBe('gpt-oss-120b')
    expect(localStorage.getItem(SETTINGS_REASONING_EFFORT)).toBe('low')
    expect(localStorage.getItem(SETTINGS_THINKING_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_WEB_SEARCH_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_CODE_EXECUTION_ENABLED)).toBe('false')
    expect(localStorage.getItem(SETTINGS_PII_CHECK_ENABLED)).toBe('true')
    expect(localStorage.getItem(SETTINGS_CHAT_FONT)).toBe('serif')
    expect(localStorage.getItem(USER_PREFS_PROJECT_UPLOAD)).toBe('chat')
  })
})
