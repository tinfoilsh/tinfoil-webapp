import {
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import type { UserPromptPreset } from './types'

const COMPONENT = 'defaultPromptPreset'

export const PROMPT_LIBRARY_CHANGED_EVENT = 'promptLibraryChanged'

export const USER_PRESET_ID_PREFIX = 'user:'

// Fixed id shared with the iOS app so a user who migrates on both platforms
// ends up with one preset rather than two.
export const MIGRATED_CUSTOM_PROMPT_PRESET_ID = `${USER_PRESET_ID_PREFIX}migrated-custom-prompt`

const MIGRATED_CUSTOM_PROMPT_PRESET_NAME = 'My default prompt'
const MIGRATED_CUSTOM_PROMPT_PRESET_DESCRIPTION =
  'Migrated from the custom default prompt setting'

function dispatchLibraryChanged(): void {
  window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_CHANGED_EVENT))
}

export function generateUserPresetId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${USER_PRESET_ID_PREFIX}${Date.now().toString(36)}-${random}`
}

export function isUserPromptPreset(value: unknown): value is UserPromptPreset {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.description === 'string' &&
    typeof p.systemPrompt === 'string' &&
    typeof p.createdAt === 'number' &&
    typeof p.updatedAt === 'number'
  )
}

export function readUserPresets(): UserPromptPreset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isUserPromptPreset)
  } catch (err) {
    logError('Failed to parse user prompt presets', err, {
      component: COMPONENT,
    })
    return []
  }
}

export function writeUserPresets(presets: UserPromptPreset[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify(presets),
    )
    dispatchLibraryChanged()
  } catch (err) {
    logError('Failed to persist user prompt presets', err, {
      component: COMPONENT,
    })
  }
}

export function readDefaultPresetId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID)
    return raw && raw.trim().length > 0 ? raw : null
  } catch (err) {
    logError('Failed to read default prompt preset', err, {
      component: COMPONENT,
    })
    return null
  }
}

export function writeDefaultPresetId(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id) {
      localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, id)
    } else {
      localStorage.removeItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID)
    }
    dispatchLibraryChanged()
  } catch (err) {
    logError('Failed to persist default prompt preset', err, {
      component: COMPONENT,
    })
  }
}

const hasSystemPromptContent = (prompt: string): boolean =>
  prompt
    .replace(/^<system>\s*\n?/, '')
    .replace(/\n?<\/system>\s*$/, '')
    .trim().length > 0

// Converts an enabled legacy custom prompt into the library preset that
// new chats default to. Skipped when a default is already chosen, since that
// choice was made on a build that no longer offers the legacy setting.
export function adoptLegacyCustomPrompt(
  enabled: boolean,
  prompt: string,
): void {
  if (!enabled || !hasSystemPromptContent(prompt)) return
  if (readDefaultPresetId() !== null) return
  const existing = readUserPresets()
  if (!existing.some((p) => p.id === MIGRATED_CUSTOM_PROMPT_PRESET_ID)) {
    const now = Date.now()
    const migrated: UserPromptPreset = {
      id: MIGRATED_CUSTOM_PROMPT_PRESET_ID,
      name: MIGRATED_CUSTOM_PROMPT_PRESET_NAME,
      description: MIGRATED_CUSTOM_PROMPT_PRESET_DESCRIPTION,
      systemPrompt: prompt,
      createdAt: now,
      updatedAt: now,
    }
    writeUserPresets([...existing, migrated])
  }
  writeDefaultPresetId(MIGRATED_CUSTOM_PROMPT_PRESET_ID)
}

// The settings page used to hold a single free-text "custom default prompt"
// behind a toggle. That prompt now lives in the library as a user preset
// marked as the default, so an enabled legacy prompt is converted once and
// the legacy keys are removed either way.
export function migrateLegacyCustomPrompt(): void {
  if (typeof window === 'undefined') return
  try {
    const enabled = localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_ENABLED)
    const prompt = localStorage.getItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT)
    if (enabled === null && prompt === null) return

    adoptLegacyCustomPrompt(enabled === 'true', prompt ?? '')

    localStorage.removeItem(USER_PREFS_CUSTOM_PROMPT_ENABLED)
    localStorage.removeItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT)
  } catch (err) {
    logError('Failed to migrate legacy custom system prompt', err, {
      component: COMPONENT,
    })
  }
}
