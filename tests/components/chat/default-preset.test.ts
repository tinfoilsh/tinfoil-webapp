import {
  adoptLegacyCustomPrompt,
  migrateLegacyCustomPrompt,
  readDefaultPresetId,
  readUserPresets,
} from '@/components/chat/prompts/default-preset'
import {
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
} from '@/constants/storage-keys'
import { beforeEach, describe, expect, it } from 'vitest'

// Retired keys and the shared migrated id are pinned as literals: the
// migration must keep reading exactly what older builds and other devices
// wrote, even if the production constants are later renamed.
const LEGACY_ENABLED_KEY = 'tinfoil-user-prefs-custom-prompt-enabled'
const LEGACY_PROMPT_KEY = 'tinfoil-user-prefs-custom-system-prompt'
const SYNCED_MIGRATED_ID = 'user:migrated-custom-prompt'

const LEGACY_PROMPT = '<system>\nAlways answer in haiku.\n</system>'

const expectLegacyKeysRemoved = () => {
  expect(localStorage.getItem(LEGACY_ENABLED_KEY)).toBeNull()
  expect(localStorage.getItem(LEGACY_PROMPT_KEY)).toBeNull()
}

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
    localStorage.setItem(LEGACY_ENABLED_KEY, 'true')
    localStorage.setItem(LEGACY_PROMPT_KEY, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    const presets = readUserPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0].systemPrompt).toBe(LEGACY_PROMPT)
    expect(presets[0].id).toBe(SYNCED_MIGRATED_ID)
    expect(readDefaultPresetId()).toBe(SYNCED_MIGRATED_ID)
    expectLegacyKeysRemoved()
  })

  it('drops a disabled legacy prompt without creating a preset', () => {
    localStorage.setItem(LEGACY_ENABLED_KEY, 'false')
    localStorage.setItem(LEGACY_PROMPT_KEY, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
    expectLegacyKeysRemoved()
  })

  it('drops an enabled but empty legacy prompt', () => {
    localStorage.setItem(LEGACY_ENABLED_KEY, 'true')
    localStorage.setItem(LEGACY_PROMPT_KEY, '<system>\n\n</system>')

    migrateLegacyCustomPrompt()

    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
    expectLegacyKeysRemoved()
  })

  it('reuses a migrated preset that already synced from another device', () => {
    const synced = {
      id: SYNCED_MIGRATED_ID,
      name: 'My default prompt',
      description: '',
      systemPrompt: LEGACY_PROMPT,
      createdAt: 1,
      updatedAt: 1,
    }
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([synced]),
    )
    localStorage.setItem(LEGACY_ENABLED_KEY, 'true')
    localStorage.setItem(LEGACY_PROMPT_KEY, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    expect(readUserPresets()).toEqual([synced])
    expect(readDefaultPresetId()).toBe(SYNCED_MIGRATED_ID)
    expectLegacyKeysRemoved()
  })

  it('keeps an existing default and discards the legacy prompt', () => {
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
    localStorage.setItem(LEGACY_ENABLED_KEY, 'true')
    localStorage.setItem(LEGACY_PROMPT_KEY, LEGACY_PROMPT)

    migrateLegacyCustomPrompt()

    // A default chosen in the library already supersedes the legacy prompt,
    // so it is discarded rather than overriding the user's newer choice.
    expect(readUserPresets()).toEqual([existing])
    expect(readDefaultPresetId()).toBe('builtin:tutor')
    expectLegacyKeysRemoved()
  })

  it('adopts an enabled prompt carried by an older cloud profile', () => {
    adoptLegacyCustomPrompt(true, LEGACY_PROMPT)

    const presets = readUserPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0].id).toBe(SYNCED_MIGRATED_ID)
    expect(readDefaultPresetId()).toBe(SYNCED_MIGRATED_ID)
  })

  it('ignores a disabled prompt carried by an older cloud profile', () => {
    adoptLegacyCustomPrompt(false, LEGACY_PROMPT)

    expect(readUserPresets()).toEqual([])
    expect(readDefaultPresetId()).toBeNull()
  })
})
