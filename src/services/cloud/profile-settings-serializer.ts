import {
  SETTINGS_MAX_PROMPT_MESSAGES,
  SETTINGS_THEME,
  SETTINGS_THEME_MODE,
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_CUSTOM_PROMPT_ENABLED,
  USER_PREFS_CUSTOM_SYSTEM_PROMPT,
  USER_PREFS_LANGUAGE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import type { ProfileData } from '@/services/cloud/profile-sync'

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
    profile1.maxPromptMessages !== profile2.maxPromptMessages ||
    profile1.language !== profile2.language ||
    profile1.nickname !== profile2.nickname ||
    profile1.profession !== profile2.profession ||
    JSON.stringify(profile1.traits) !== JSON.stringify(profile2.traits) ||
    profile1.additionalContext !== profile2.additionalContext ||
    profile1.isUsingPersonalization !== profile2.isUsingPersonalization ||
    profile1.isUsingCustomPrompt !== profile2.isUsingCustomPrompt ||
    profile1.customSystemPrompt !== profile2.customSystemPrompt
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

  // Chat settings
  const maxMessages = localStorage.getItem(SETTINGS_MAX_PROMPT_MESSAGES)
  if (maxMessages) {
    const parsed = parseInt(maxMessages, 10)
    if (!isNaN(parsed)) {
      settings.maxPromptMessages = parsed
    }
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

  return settings
}

/**
 * Apply cloud-synced settings to localStorage and dispatch change events
 * so the UI reacts to the updated values.
 */
export function applySettingsToLocal(settings: ProfileData): void {
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

  // Chat settings
  if (settings.maxPromptMessages !== undefined) {
    localStorage.setItem(
      SETTINGS_MAX_PROMPT_MESSAGES,
      settings.maxPromptMessages.toString(),
    )
    window.dispatchEvent(
      new CustomEvent('maxPromptMessagesChanged', {
        detail: settings.maxPromptMessages,
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
