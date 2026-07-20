import {
  SETTINGS_CHAT_FONT,
  SETTINGS_CODE_EXECUTION_ENABLED,
  SETTINGS_GENUI_ENABLED,
  SETTINGS_PII_CHECK_ENABLED,
  SETTINGS_REASONING_EFFORT,
  SETTINGS_THEME,
  SETTINGS_THEME_MODE,
  SETTINGS_THINKING_ENABLED,
  SETTINGS_WEB_SEARCH_AVAILABLE,
  SETTINGS_WEB_SEARCH_ENABLED,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
  USER_PREFS_LANGUAGE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_PROJECT_UPLOAD,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import type {
  ProfileData,
  ProfilePromptPreset,
} from '@/services/cloud/profile-sync'
import { logWarning } from '@/utils/error-handling'
import { ProfileDataSchema } from './schemas'

const DEFAULT_PROFILE_LANGUAGE = 'English'

function safeParsePromptPresets(raw: string | null): ProfilePromptPreset[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (preset): preset is ProfilePromptPreset =>
        preset &&
        typeof preset === 'object' &&
        typeof preset.id === 'string' &&
        typeof preset.name === 'string' &&
        typeof preset.description === 'string' &&
        typeof preset.systemPrompt === 'string' &&
        typeof preset.createdAt === 'number' &&
        typeof preset.updatedAt === 'number',
    )
  } catch {
    return []
  }
}

function safeParseFavoritePresetIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

/**
 * Check if two profile data objects differ in any meaningful field (excluding metadata).
 */
export function hasProfileChanged(
  profile1: ProfileData | null,
  profile2: ProfileData | null,
): boolean {
  if (!profile1 || !profile2) return profile1 !== profile2

  return (
    profile1.isDarkMode !== profile2.isDarkMode ||
    profile1.themeMode !== profile2.themeMode ||
    profile1.language !== profile2.language ||
    profile1.nickname !== profile2.nickname ||
    profile1.profession !== profile2.profession ||
    JSON.stringify(profile1.traits) !== JSON.stringify(profile2.traits) ||
    profile1.additionalContext !== profile2.additionalContext ||
    profile1.isUsingPersonalization !== profile2.isUsingPersonalization ||
    profile1.isUsingCustomPrompt !== profile2.isUsingCustomPrompt ||
    profile1.customSystemPrompt !== profile2.customSystemPrompt ||
    JSON.stringify(profile1.customPromptPresets) !==
      JSON.stringify(profile2.customPromptPresets) ||
    JSON.stringify(profile1.favoritePromptPresetIds) !==
      JSON.stringify(profile2.favoritePromptPresetIds) ||
    profile1.reasoningEffort !== profile2.reasoningEffort ||
    profile1.thinkingEnabled !== profile2.thinkingEnabled ||
    profile1.webSearchEnabled !== profile2.webSearchEnabled ||
    profile1.webSearchAvailable !== profile2.webSearchAvailable ||
    profile1.codeExecutionEnabled !== profile2.codeExecutionEnabled ||
    profile1.piiCheckEnabled !== profile2.piiCheckEnabled ||
    profile1.genUIEnabled !== profile2.genUIEnabled ||
    profile1.chatFont !== profile2.chatFont ||
    profile1.projectUploadPreference !== profile2.projectUploadPreference
  )
}

/**
 * Load the current user settings from localStorage into a ProfileData object.
 */
export function loadLocalSettings(): ProfileData {
  const settings: ProfileData = {}

  // Theme
  const savedTheme = localStorage.getItem(SETTINGS_THEME)
  if (savedTheme) {
    settings.isDarkMode = savedTheme === 'dark'
  }
  const savedThemeMode = localStorage.getItem(SETTINGS_THEME_MODE)
  if (
    savedThemeMode === 'light' ||
    savedThemeMode === 'dark' ||
    savedThemeMode === 'system'
  ) {
    settings.themeMode = savedThemeMode
  }

  const language = localStorage.getItem(USER_PREFS_LANGUAGE)
  if (language) {
    settings.language = language
  }

  // Personalization
  const nickname = localStorage.getItem(USER_PREFS_NICKNAME)
  if (nickname !== null) settings.nickname = nickname

  const profession = localStorage.getItem(USER_PREFS_PROFESSION)
  if (profession !== null) settings.profession = profession

  const traits = localStorage.getItem(USER_PREFS_TRAITS)
  if (traits) {
    try {
      settings.traits = JSON.parse(traits)
    } catch {
      settings.traits = []
    }
  }

  const additionalContext = localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT)
  if (additionalContext !== null) settings.additionalContext = additionalContext

  const isUsingPersonalization = localStorage.getItem(
    USER_PREFS_PERSONALIZATION_ENABLED,
  )
  if (isUsingPersonalization) {
    settings.isUsingPersonalization = isUsingPersonalization === 'true'
  }

  // Custom system prompt settings
  const isUsingCustomPrompt = localStorage.getItem(
    USER_PREFS_CUSTOM_PROMPT_ENABLED,
  )
  if (isUsingCustomPrompt) {
    settings.isUsingCustomPrompt = isUsingCustomPrompt === 'true'
  }

  const customSystemPrompt = localStorage.getItem(
    USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  )
  if (customSystemPrompt !== null) {
    settings.customSystemPrompt = customSystemPrompt
  }

  const customPromptPresets = localStorage.getItem(
    USER_PREFS_CUSTOM_PROMPT_PRESETS,
  )
  if (customPromptPresets !== null) {
    settings.customPromptPresets = safeParsePromptPresets(customPromptPresets)
  }

  const favoritePromptPresetIds = localStorage.getItem(
    USER_PREFS_FAVORITE_PROMPT_PRESETS,
  )
  if (favoritePromptPresetIds !== null) {
    settings.favoritePromptPresetIds = safeParseFavoritePresetIds(
      favoritePromptPresetIds,
    )
  }

  const reasoningEffort = localStorage.getItem(SETTINGS_REASONING_EFFORT)
  if (
    reasoningEffort === 'low' ||
    reasoningEffort === 'medium' ||
    reasoningEffort === 'high'
  ) {
    settings.reasoningEffort = reasoningEffort
  }

  const thinkingEnabled = localStorage.getItem(SETTINGS_THINKING_ENABLED)
  if (thinkingEnabled !== null) {
    settings.thinkingEnabled = thinkingEnabled === 'true'
  }

  const webSearchEnabled = localStorage.getItem(SETTINGS_WEB_SEARCH_ENABLED)
  if (webSearchEnabled !== null) {
    settings.webSearchEnabled = webSearchEnabled === 'true'
  }

  const webSearchAvailable = localStorage.getItem(SETTINGS_WEB_SEARCH_AVAILABLE)
  settings.webSearchAvailable =
    webSearchAvailable === null ? true : webSearchAvailable === 'true'

  const codeExecutionEnabled = localStorage.getItem(
    SETTINGS_CODE_EXECUTION_ENABLED,
  )
  if (codeExecutionEnabled !== null) {
    settings.codeExecutionEnabled = codeExecutionEnabled === 'true'
  }

  const piiCheckEnabled = localStorage.getItem(SETTINGS_PII_CHECK_ENABLED)
  if (piiCheckEnabled !== null) {
    settings.piiCheckEnabled = piiCheckEnabled === 'true'
  }

  const genUIEnabled = localStorage.getItem(SETTINGS_GENUI_ENABLED)
  if (genUIEnabled !== null) {
    settings.genUIEnabled = genUIEnabled === 'true'
  }

  const chatFont = localStorage.getItem(SETTINGS_CHAT_FONT)
  if (
    chatFont === 'system' ||
    chatFont === 'serif' ||
    chatFont === 'mono' ||
    chatFont === 'dyslexic'
  ) {
    settings.chatFont = chatFont
  }

  const projectUploadPreference = localStorage.getItem(
    USER_PREFS_PROJECT_UPLOAD,
  )
  if (
    projectUploadPreference === 'project' ||
    projectUploadPreference === 'chat'
  ) {
    settings.projectUploadPreference = projectUploadPreference
  }

  return settings
}

export function resetSettingsToLocalDefaults(): ProfileData {
  const defaults: ProfileData = {
    themeMode: 'system',
    language: DEFAULT_PROFILE_LANGUAGE,
    nickname: '',
    profession: '',
    traits: [],
    additionalContext: '',
    isUsingPersonalization: false,
    isUsingCustomPrompt: false,
    customSystemPrompt: '',
    customPromptPresets: [],
    favoritePromptPresetIds: [],
    reasoningEffort: 'medium',
    thinkingEnabled: true,
    webSearchEnabled: true,
    webSearchAvailable: true,
    codeExecutionEnabled: false,
    piiCheckEnabled: true,
    genUIEnabled: true,
    chatFont: 'system',
  }

  applySettingsToLocal(defaults)
  // Return the round-tripped snapshot rather than `defaults`: applying
  // populates derived keys (e.g. the legacy dark-mode flag) that
  // loadLocalSettings always reads back, and a baseline missing them
  // would make every later change comparison report a diff.
  return loadLocalSettings()
}

/**
 * Apply cloud-synced settings to localStorage and dispatch change events
 * so the UI reacts to the updated values.
 */
export function applySettingsToLocal(settings: ProfileData): void {
  const validation = ProfileDataSchema.safeParse(settings)
  if (!validation.success) {
    logWarning('Skipping settings apply for invalid profile shape', {
      component: 'ProfileSettingsSerializer',
      action: 'applySettingsToLocal',
      metadata: { issues: validation.error.message },
    })
    return
  }

  // Theme - prefer themeMode if available, fall back to isDarkMode for backwards compatibility
  if (settings.themeMode) {
    localStorage.setItem(SETTINGS_THEME_MODE, settings.themeMode)
    // Also set legacy theme key
    if (settings.themeMode === 'system') {
      const prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches
      localStorage.setItem(SETTINGS_THEME, prefersDark ? 'dark' : 'light')
    } else {
      localStorage.setItem(SETTINGS_THEME, settings.themeMode)
    }
    // Trigger theme change event
    window.dispatchEvent(
      new CustomEvent('themeChanged', {
        detail: settings.themeMode,
      }),
    )
  } else if (settings.isDarkMode !== undefined) {
    // Legacy: only isDarkMode available (old profile data)
    const theme = settings.isDarkMode ? 'dark' : 'light'
    localStorage.setItem(SETTINGS_THEME, theme)
    localStorage.setItem(SETTINGS_THEME_MODE, theme)
    // Trigger theme change event
    window.dispatchEvent(
      new CustomEvent('themeChanged', {
        detail: theme,
      }),
    )
  }

  if (settings.language !== undefined) {
    localStorage.setItem(USER_PREFS_LANGUAGE, settings.language)
    window.dispatchEvent(
      new CustomEvent('languageChanged', {
        detail: { language: settings.language },
      }),
    )
  }

  const shouldApplyPersonalization =
    settings.nickname !== undefined ||
    settings.profession !== undefined ||
    settings.traits !== undefined ||
    settings.additionalContext !== undefined ||
    settings.isUsingPersonalization !== undefined

  // Personalization: only apply fields that the cloud payload explicitly
  // provided so a partial update never erases unrelated local values.
  if (settings.nickname !== undefined) {
    localStorage.setItem(USER_PREFS_NICKNAME, settings.nickname)
  }
  if (settings.profession !== undefined) {
    localStorage.setItem(USER_PREFS_PROFESSION, settings.profession)
  }
  if (settings.traits !== undefined) {
    localStorage.setItem(USER_PREFS_TRAITS, JSON.stringify(settings.traits))
  }
  if (settings.additionalContext !== undefined) {
    localStorage.setItem(
      USER_PREFS_ADDITIONAL_CONTEXT,
      settings.additionalContext,
    )
  }
  if (settings.isUsingPersonalization !== undefined) {
    localStorage.setItem(
      USER_PREFS_PERSONALIZATION_ENABLED,
      settings.isUsingPersonalization.toString(),
    )
  }

  // Custom system prompt settings
  if (settings.isUsingCustomPrompt !== undefined) {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_ENABLED,
      settings.isUsingCustomPrompt.toString(),
    )
  }

  if (settings.customSystemPrompt !== undefined) {
    localStorage.setItem(
      USER_PREFS_CUSTOM_SYSTEM_PROMPT,
      settings.customSystemPrompt,
    )
  }

  if (settings.customPromptPresets !== undefined) {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify(settings.customPromptPresets),
    )
    window.dispatchEvent(new CustomEvent('promptLibraryChanged'))
  }

  if (settings.favoritePromptPresetIds !== undefined) {
    localStorage.setItem(
      USER_PREFS_FAVORITE_PROMPT_PRESETS,
      JSON.stringify(settings.favoritePromptPresetIds),
    )
    window.dispatchEvent(new CustomEvent('promptLibraryChanged'))
  }

  const shouldApplyReasoning =
    settings.reasoningEffort !== undefined ||
    settings.thinkingEnabled !== undefined

  if (settings.reasoningEffort !== undefined) {
    localStorage.setItem(SETTINGS_REASONING_EFFORT, settings.reasoningEffort)
  }

  if (settings.thinkingEnabled !== undefined) {
    localStorage.setItem(
      SETTINGS_THINKING_ENABLED,
      String(settings.thinkingEnabled),
    )
  }

  if (shouldApplyReasoning) {
    window.dispatchEvent(
      new CustomEvent('reasoningSettingsChanged', {
        detail: {
          reasoningEffort:
            settings.reasoningEffort ??
            localStorage.getItem(SETTINGS_REASONING_EFFORT) ??
            'medium',
          thinkingEnabled:
            settings.thinkingEnabled ??
            localStorage.getItem(SETTINGS_THINKING_ENABLED) !== 'false',
        },
      }),
    )
  }

  if (settings.webSearchEnabled !== undefined) {
    localStorage.setItem(
      SETTINGS_WEB_SEARCH_ENABLED,
      String(settings.webSearchEnabled),
    )
    window.dispatchEvent(
      new CustomEvent('webSearchEnabledChanged', {
        detail: { enabled: settings.webSearchEnabled },
      }),
    )
  }

  if (settings.webSearchAvailable !== undefined) {
    localStorage.setItem(
      SETTINGS_WEB_SEARCH_AVAILABLE,
      String(settings.webSearchAvailable),
    )
    window.dispatchEvent(
      new CustomEvent('webSearchAvailableChanged', {
        detail: { enabled: settings.webSearchAvailable },
      }),
    )
  }

  if (settings.codeExecutionEnabled !== undefined) {
    localStorage.setItem(
      SETTINGS_CODE_EXECUTION_ENABLED,
      String(settings.codeExecutionEnabled),
    )
    window.dispatchEvent(
      new CustomEvent('codeExecutionEnabledChanged', {
        detail: { enabled: settings.codeExecutionEnabled },
      }),
    )
  }

  if (settings.piiCheckEnabled !== undefined) {
    localStorage.setItem(
      SETTINGS_PII_CHECK_ENABLED,
      String(settings.piiCheckEnabled),
    )
    window.dispatchEvent(
      new CustomEvent('piiCheckEnabledChanged', {
        detail: { enabled: settings.piiCheckEnabled },
      }),
    )
  }

  if (settings.genUIEnabled !== undefined) {
    localStorage.setItem(SETTINGS_GENUI_ENABLED, String(settings.genUIEnabled))
    window.dispatchEvent(
      new CustomEvent('genUIEnabledChanged', {
        detail: { enabled: settings.genUIEnabled },
      }),
    )
  }

  if (settings.chatFont !== undefined) {
    localStorage.setItem(SETTINGS_CHAT_FONT, settings.chatFont)
    window.dispatchEvent(
      new CustomEvent('chatFontChanged', {
        detail: settings.chatFont,
      }),
    )
  }

  if (settings.projectUploadPreference !== undefined) {
    localStorage.setItem(
      USER_PREFS_PROJECT_UPLOAD,
      settings.projectUploadPreference,
    )
    window.dispatchEvent(
      new CustomEvent('projectUploadPreferenceChanged', {
        detail: settings.projectUploadPreference,
      }),
    )
  }

  // Trigger custom system prompt change event
  if (
    settings.isUsingCustomPrompt !== undefined ||
    settings.customSystemPrompt !== undefined
  ) {
    window.dispatchEvent(
      new CustomEvent('customSystemPromptChanged', {
        detail: {
          isEnabled:
            settings.isUsingCustomPrompt ??
            localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_ENABLED) === 'true',
          customPrompt:
            settings.customSystemPrompt ||
            localStorage.getItem(USER_PREFS_CUSTOM_SYSTEM_PROMPT) ||
            '',
        },
      }),
    )
  }

  // Trigger personalization change event
  if (shouldApplyPersonalization) {
    window.dispatchEvent(
      new CustomEvent('personalizationChanged', {
        detail: {
          nickname:
            settings.nickname ??
            localStorage.getItem(USER_PREFS_NICKNAME) ??
            '',
          profession:
            settings.profession ??
            localStorage.getItem(USER_PREFS_PROFESSION) ??
            '',
          traits:
            settings.traits ??
            (() => {
              try {
                return JSON.parse(
                  localStorage.getItem(USER_PREFS_TRAITS) || '[]',
                )
              } catch {
                return []
              }
            })(),
          additionalContext:
            settings.additionalContext ??
            localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT) ??
            '',
          language:
            settings.language ??
            localStorage.getItem(USER_PREFS_LANGUAGE) ??
            'English',
          isEnabled:
            settings.isUsingPersonalization ??
            localStorage.getItem(USER_PREFS_PERSONALIZATION_ENABLED) === 'true',
        },
      }),
    )
  }
}
