import {
  migrateLegacyCustomPrompt,
  readDefaultPresetId,
  readUserPresets,
} from '@/components/chat/prompts/default-preset'
import {
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
} from '@/constants/storage-keys'
import { beforeEach, describe, expect, it } from 'vitest'

const LEGACY_PROMPT = '<system>\nAlways answer in haiku.\n</system>'

describe('migrateLegacyCustomPrompt', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('does nothing when no legacy keys exist', () => {
    migrateLegacyCustomPrompt()
    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
  })

  it('converts an enabled legacy prompt into the default user preset', () => {
    localStorage.setItem(USER_PREFS_CUSTOM_PROMPT_ENABLED, 'true')
    localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    const presets = readUserPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0].systemPrompt).toBe(LEGACY_PROMPT)
    expect(presets[0].id.startsWith('user:')).toBe(true)
    expect(readDefaultPresetId()).toBe(presets[0].id)
    expect(localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_ENABLED)).toBeNull()
    expect(localStorage.getItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT)).toBeNull()
  })

  it('drops a disabled legacy prompt without creating a preset', () => {
    localStorage.setItem(USER_PREFS_CUSTOM_PROMPT_ENABLED, 'false')
    localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
    expect(localStorage.getItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT)).toBeNull()
  })

  it('drops an enabled but empty legacy prompt', () => {
    localStorage.setItem(USER_PREFS_CUSTOM_PROMPT_ENABLED, 'true')
    localStorage.setItem(
      USER_PREFS_CUSTOM_SYSTEM_PROMPT,
      '<system>\n\n</system>',
    )

    migrateLegacyCustomPrompt()

    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
  })

  it('keeps an existing default and appends to existing presets', () => {
    const existing = {
      id: 'user:existing',
      name: 'Existing',
      description: '',
      systemPrompt: '<system>\nHi.\n</system>',
      createdAt: 1,
      updatedAt: 1,
    }
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([existing]),
    )
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, 'builtin:tutor')
    localStorage.setItem(USER_PREFS_CUSTOM_PROMPT_ENABLED, 'true')
    localStorage.setItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    // A default chosen in the library already supersedes the legacy prompt,
    // so it is discarded rather than overriding the user's newer choice.
    expect(readUserPresets()).toEqual([existing])
    expect(readDefaultPresetId()).toBe('builtin:tutor')
    expect(localStorage.getItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT)).toBeNull()
  })
})
