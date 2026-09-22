import {
  adoptLegacyCustomPrompt,
  isUserPromptPreset,
  migrateLegacyCustomPrompt,
  pruneUnavailablePresetModels,
  readDefaultPresetId,
  readUserPresets,
} from '@/components/chat/prompts/default-preset'
import type { UserPromptPreset } from '@/components/chat/prompts/types'
import { AUTO_MODEL_ID, type BaseModel } from '@/config/models'
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

const basePreset = (
  overrides: Partial<UserPromptPreset> = {},
): UserPromptPreset => ({
  id: 'user:p1',
  name: 'Proofreader',
  description: '',
  systemPrompt: '<system>\nFix typos.\n</system>',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('isUserPromptPreset', () => {
  it('accepts presets with and without chat settings', () => {
    expect(isUserPromptPreset(basePreset())).toBe(true)
    expect(
      isUserPromptPreset(
        basePreset({ model: 'gpt-oss-120b', webSearchEnabled: false }),
      ),
    ).toBe(true)
  })

  it('rejects malformed chat settings', () => {
    expect(isUserPromptPreset({ ...basePreset(), model: 42 })).toBe(false)
    expect(isUserPromptPreset({ ...basePreset(), model: null })).toBe(false)
    expect(
      isUserPromptPreset({ ...basePreset(), webSearchEnabled: 'off' }),
    ).toBe(false)
  })
})

describe('pruneUnavailablePresetModels', () => {
  const chatModel = (modelName: string): BaseModel => ({
    modelName,
    image: '',
    name: modelName,
    nameShort: modelName,
    description: '',
    type: 'chat',
    chat: true,
  })
  const catalog = [chatModel('gpt-oss-120b')]

  const writePresets = (presets: UserPromptPreset[]) =>
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify(presets),
    )

  beforeEach(() => {
    localStorage.clear()
  })

  it('clears models missing from the catalog and bumps updatedAt', () => {
    writePresets([
      basePreset({ id: 'user:stale', model: 'retired-model' }),
      basePreset({ id: 'user:fresh', model: 'gpt-oss-120b' }),
    ])

    const pruned = pruneUnavailablePresetModels(catalog)

    expect(pruned).toEqual(['user:stale'])
    const [stale, fresh] = readUserPresets()
    expect(stale.model).toBeUndefined()
    expect('model' in stale).toBe(false)
    expect(stale.updatedAt).toBeGreaterThan(1)
    expect(fresh.model).toBe('gpt-oss-120b')
    expect(fresh.updatedAt).toBe(1)
  })

  it('keeps Auto and presets without a model', () => {
    const presets = [
      basePreset({ id: 'user:auto', model: AUTO_MODEL_ID }),
      basePreset({ id: 'user:none', webSearchEnabled: false }),
    ]
    writePresets(presets)

    expect(pruneUnavailablePresetModels(catalog)).toEqual([])
    expect(readUserPresets()).toEqual(presets)
  })

  it('does not rewrite storage when nothing is stale', () => {
    const presets = [basePreset({ model: 'gpt-oss-120b' })]
    writePresets(presets)
    const before = localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)

    pruneUnavailablePresetModels(catalog)

    expect(localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)).toBe(before)
  })
})
