import {
  SETTINGS_AUTO_INTELLIGENCE,
  SETTINGS_BROWSER_TAB_CHAT_TITLE_ENABLED,
  SETTINGS_CHAT_FONT,
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_ENTER_TO_NEWLINE_ENABLED,
  SETTINGS_GENUI_ENABLED,
  SETTINGS_HAS_SEEN_ONBOARDING,
  SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_SELECTED_MODEL,
  SETTINGS_THEME_MODE,
  SETTINGS_THINKING_ENABLED,
  SETTINGS_WEB_SEARCH_ENABLED,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
  USER_PREFS_LANGUAGE,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { isPersonalizationEnabled } from '@/utils/personalization-settings'
import type { Json, RecordValue } from './types'

// The settings of a chat the harness does not store: a signed-in account
// without cloud sync, or a signed-out visitor. They use the harness profile's
// field names and live under one local storage key.
export type LocalProfile = RecordValue

const STRING_FIELDS = [
  'themeMode',
  'chatFont',
  'language',
  'nickname',
  'profession',
  'additionalContext',
  'customSystemPrompt',
  // The preset new chats start with; an empty string for none.
  'defaultPromptPresetId',
  'selectedModel',
  'autoIntelligence',
  'reasoningEffort',
]
const BOOLEAN_FIELDS = [
  'isUsingPersonalization',
  'isUsingCustomPrompt',
  'thinkingEnabled',
  'webSearchEnabled',
  'codeExecutionEnabled',
  'piiCheckEnabled',
  'genUIEnabled',
  'pixelateSidebarChatTitlesEnabled',
  'browserTabChatTitleEnabled',
  'enterToNewlineEnabled',
  'hasSeenOnboarding',
  'hasSeenWebSearchIntro',
]
const CHOICES: Record<string, string[]> = {
  themeMode: ['light', 'dark', 'system'],
  chatFont: ['system', 'serif', 'mono', 'dyslexic'],
  reasoningEffort: ['low', 'medium', 'high'],
  autoIntelligence: ['instant', 'low', 'medium', 'high', 'extra', 'max'],
}
const MAX_LIST_ENTRIES = 500

// What a prompt reads. The harness ignores other fields of a local turn's
// profile; the agent sandbox setting is left out because the harness refuses
// turns that enable it.
const PROMPT_FIELDS = [
  'language',
  'nickname',
  'profession',
  'traits',
  'additionalContext',
  'isUsingPersonalization',
  'isUsingCustomPrompt',
  'customSystemPrompt',
  'customPromptPresets',
  'selectedModel',
  'autoIntelligence',
  'reasoningEffort',
  'thinkingEnabled',
  'webSearchEnabled',
  'codeExecutionEnabled',
  'piiCheckEnabled',
  'genUIEnabled',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// The harness's validateProfile, per field: a value it would refuse is
// dropped instead, so one bad setting cannot block every local turn.
function validField(field: string, value: unknown): value is Json {
  if (STRING_FIELDS.includes(field))
    return (
      typeof value === 'string' &&
      (!CHOICES[field] || CHOICES[field].includes(value))
    )
  if (BOOLEAN_FIELDS.includes(field)) return typeof value === 'boolean'
  if (field === 'traits' || field === 'favoritePromptPresetIds')
    return (
      Array.isArray(value) &&
      value.length <= MAX_LIST_ENTRIES &&
      value.every((entry) => typeof entry === 'string')
    )
  if (field === 'customPromptPresets')
    return (
      Array.isArray(value) &&
      value.length <= MAX_LIST_ENTRIES &&
      value.every(
        (preset) =>
          isRecord(preset) &&
          typeof preset.id === 'string' &&
          preset.id !== '' &&
          typeof preset.name === 'string' &&
          preset.name !== '' &&
          ['description', 'systemPrompt', 'model'].every(
            (key) =>
              preset[key] === undefined || typeof preset[key] === 'string',
          ) &&
          (preset.webSearchEnabled === undefined ||
            typeof preset.webSearchEnabled === 'boolean'),
      )
    )
  if (field === 'dismissed')
    return (
      isRecord(value) &&
      Object.values(value).every((entry) => typeof entry === 'boolean')
    )
  return false
}

function validProfile(value: unknown): LocalProfile {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([field, entry]) => validField(field, entry)),
  ) as LocalProfile
}

function parseJSON(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

// Settings the previous client kept under one key per setting.
function previousClientSettings(): LocalProfile {
  const text = (key: string) => localStorage.getItem(key) ?? undefined
  const flag = (key: string) => {
    const value = localStorage.getItem(key)
    return value === null ? undefined : value === 'true'
  }
  const personalization = localStorage.getItem(
    USER_PREFS_PERSONALIZATION_ENABLED,
  )
  return validProfile({
    language: text(USER_PREFS_LANGUAGE),
    nickname: text(USER_PREFS_NICKNAME),
    profession: text(USER_PREFS_PROFESSION),
    traits: parseJSON(localStorage.getItem(USER_PREFS_TRAITS)),
    additionalContext: text(USER_PREFS_ADDITIONAL_CONTEXT),
    isUsingPersonalization:
      personalization === null
        ? undefined
        : isPersonalizationEnabled(personalization),
    isUsingCustomPrompt: flag(USER_PREFS_CUSTOM_PROMPT_ENABLED),
    customSystemPrompt: text(USER_PREFS_CUSTOM_SYSTEM_PROMPT),
    customPromptPresets: parseJSON(
      localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS),
    ),
    favoritePromptPresetIds: parseJSON(
      localStorage.getItem(USER_PREFS_FAVORITE_PROMPT_PRESETS),
    ),
    defaultPromptPresetId: text(USER_PREFS_DEFAULT_PROMPT_PRESET_ID),
    selectedModel: text(SETTINGS_SELECTED_MODEL),
    autoIntelligence: text(SETTINGS_AUTO_INTELLIGENCE),
    reasoningEffort: text(SETTINGS_REASONING_EFFORT),
    thinkingEnabled: flag(SETTINGS_THINKING_ENABLED),
    webSearchEnabled: flag(SETTINGS_WEB_SEARCH_ENABLED),
    codeExecutionEnabled: flag(SETTINGS_CODE_EXECUTION_ENABLED),
    piiCheckEnabled: flag(SETTINGS_PII_CHECK_ENABLED),
    genUIEnabled: flag(SETTINGS_GENUI_ENABLED),
    themeMode: text(SETTINGS_THEME_MODE),
    chatFont: text(SETTINGS_CHAT_FONT),
    pixelateSidebarChatTitlesEnabled: flag(
      SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
    ),
    browserTabChatTitleEnabled: flag(SETTINGS_BROWSER_TAB_CHAT_TITLE_ENABLED),
    enterToNewlineEnabled: flag(SETTINGS_ENTER_TO_NEWLINE_ENABLED),
    hasSeenOnboarding: flag(SETTINGS_HAS_SEEN_ONBOARDING),
    hasSeenWebSearchIntro: flag(SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO),
  })
}

function write(profile: LocalProfile): void {
  try {
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE, JSON.stringify(profile))
  } catch (error) {
    logError('Failed to save local settings', error, {
      component: 'localProfile',
      action: 'write',
    })
  }
}

// The first read imports the previous client's settings once; afterwards
// only the local profile key is read.
export function loadLocalProfile(): LocalProfile {
  try {
    const stored = localStorage.getItem(USER_PREFS_LOCAL_PROFILE)
    if (stored !== null) return validProfile(parseJSON(stored))
    const imported = previousClientSettings()
    if (Object.keys(imported).length > 0) write(imported)
    return imported
  } catch (error) {
    logError('Failed to read local settings', error, {
      component: 'localProfile',
      action: 'loadLocalProfile',
    })
    return {}
  }
}

export function saveLocalProfile(
  patch: Record<string, unknown>,
  replace = false,
): LocalProfile {
  const profile = validProfile({
    ...(replace ? {} : loadLocalProfile()),
    ...patch,
  })
  write(profile)
  return profile
}

export function turnProfile(profile: Record<string, unknown>): RecordValue {
  return Object.fromEntries(
    PROMPT_FIELDS.flatMap((field) =>
      validField(field, profile[field]) ? [[field, profile[field]]] : [],
    ),
  ) as RecordValue
}
