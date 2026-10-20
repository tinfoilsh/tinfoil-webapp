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
import type { RecordValue } from './types'

// The settings of a chat the harness does not store: a signed-in account
// without cloud sync, or a signed-out visitor. They use the harness profile's
// field names and live under one local storage key. The harness reads the
// fields it knows of a device turn's profile and drops invalid ones.
export type LocalProfile = RecordValue

const isRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const defined = (value: Record<string, unknown>): LocalProfile =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as LocalProfile

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
  return defined({
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
    if (stored !== null) {
      const profile = parseJSON(stored)
      return isRecord(profile) ? profile : {}
    }
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
  const profile = defined({
    ...(replace ? {} : loadLocalProfile()),
    ...patch,
  })
  write(profile)
  return profile
}
