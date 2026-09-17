import {
  USER_PREFS_ADDITIONAL_CONTEXT,
  USER_PREFS_LANGUAGE,
  USER_PREFS_NICKNAME,
  USER_PREFS_PERSONALIZATION_ENABLED,
  USER_PREFS_PROFESSION,
  USER_PREFS_TRAITS,
} from '@/constants/storage-keys'
import {
  isPersonalizationEnabled,
  type PersonalizationSettings,
} from '@/utils/personalization-settings'
import { escapePromptContent } from '@/utils/prompt-escaping'
import {
  normalizeResponseLanguage,
  resolveResponseLanguage,
} from '@/utils/response-language'
import { useEffect, useState } from 'react'

type UseCustomSystemPromptReturn = {
  effectiveSystemPrompt: string
  processedRules: string
  isUsingPersonalization: boolean
}

export const useCustomSystemPrompt = (
  defaultSystemPrompt: string,
  rules: string = '',
  activePresetPrompt?: string | null,
): UseCustomSystemPromptReturn => {
  const [personalization, setPersonalization] =
    useState<PersonalizationSettings>({
      nickname: '',
      profession: '',
      traits: [],
      additionalContext: '',
      language: normalizeResponseLanguage(null),
      isEnabled: true,
    })

  // Load personalization settings from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedNickname = localStorage.getItem(USER_PREFS_NICKNAME) || ''
      const savedProfession = localStorage.getItem(USER_PREFS_PROFESSION) || ''
      const savedTraits = localStorage.getItem(USER_PREFS_TRAITS)
      const savedContext =
        localStorage.getItem(USER_PREFS_ADDITIONAL_CONTEXT) || ''
      const savedLanguage = localStorage.getItem(USER_PREFS_LANGUAGE)
      const savedEnabled = localStorage.getItem(
        USER_PREFS_PERSONALIZATION_ENABLED,
      )

      let traits: string[] = []
      if (savedTraits) {
        try {
          traits = JSON.parse(savedTraits)
        } catch {
          traits = []
        }
      }

      const language = normalizeResponseLanguage(savedLanguage)

      setPersonalization({
        nickname: savedNickname,
        profession: savedProfession,
        traits,
        additionalContext: savedContext,
        language,
        isEnabled: isPersonalizationEnabled(savedEnabled),
      })
    }
  }, [])

  // Listen for personalization changes from settings sidebar
  useEffect(() => {
    const handlePersonalizationChange = (event: CustomEvent) => {
      const {
        nickname,
        profession,
        traits,
        additionalContext,
        language,
        isEnabled,
      } = event.detail
      setPersonalization((previous) => ({
        nickname: nickname || '',
        profession: profession || '',
        traits: traits || [],
        additionalContext: additionalContext || '',
        language:
          typeof language === 'string'
            ? normalizeResponseLanguage(language)
            : previous.language,
        isEnabled: isEnabled !== false,
      }))
    }

    const handleLanguageChange = (event: CustomEvent) => {
      const { language } = event.detail
      setPersonalization((prev) => ({
        ...prev,
        language: normalizeResponseLanguage(language),
      }))
    }

    window.addEventListener(
      'personalizationChanged',
      handlePersonalizationChange as EventListener,
    )
    window.addEventListener(
      'languageChanged',
      handleLanguageChange as EventListener,
    )

    return () => {
      window.removeEventListener(
        'personalizationChanged',
        handlePersonalizationChange as EventListener,
      )
      window.removeEventListener(
        'languageChanged',
        handleLanguageChange as EventListener,
      )
    }
  }, [])

  // Generate the user preferences XML
  const generateUserPreferencesXML = (): string => {
    // Check if any personalization fields are filled
    const hasPersonalization =
      personalization.nickname.trim() ||
      personalization.profession.trim() ||
      personalization.traits.length > 0 ||
      personalization.additionalContext.trim()

    if (!hasPersonalization) {
      return ''
    }

    let userPreferencesXML =
      'The user has provided personal preferences for this conversation. Adapt your responses according to these settings while maintaining accuracy and helpfulness.\n\n<user_preferences>'

    if (personalization.nickname.trim()) {
      userPreferencesXML += `\n  <nickname>${escapePromptContent(personalization.nickname.trim())}</nickname>`
    }

    if (personalization.profession.trim()) {
      userPreferencesXML += `\n  <profession>${escapePromptContent(personalization.profession.trim())}</profession>`
    }

    if (personalization.traits.length > 0) {
      userPreferencesXML += '\n  <traits>'
      personalization.traits.forEach((trait) => {
        userPreferencesXML += `\n    <trait>${escapePromptContent(trait)}</trait>`
      })
      userPreferencesXML += '\n  </traits>'
    }

    if (personalization.additionalContext.trim()) {
      userPreferencesXML += `\n  <additional_context>\n    ${escapePromptContent(personalization.additionalContext.trim())}\n  </additional_context>`
    }

    userPreferencesXML += '\n</user_preferences>'

    return userPreferencesXML
  }

  // Shared helper to replace placeholders in text
  const replacePlaceholders = (text: string): string => {
    const userPreferencesXML = personalization.isEnabled
      ? generateUserPreferencesXML()
      : ''

    const effectiveLanguage = resolveResponseLanguage(personalization.language)

    // Extract timezone separately
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    // Replace all placeholders
    return text
      .replace('{USER_PREFERENCES}', userPreferencesXML)
      .replace('{LANGUAGE}', effectiveLanguage)
      .replace('{TIMEZONE}', timezone)
  }

  // Generate the effective system prompt by replacing the placeholder
  const generatePersonalizedPrompt = (): string => {
    // Precedence: per-chat preset > server default
    const basePrompt =
      activePresetPrompt && activePresetPrompt.trim()
        ? activePresetPrompt
        : defaultSystemPrompt
    return replacePlaceholders(basePrompt)
  }

  const effectiveSystemPrompt = generatePersonalizedPrompt()

  // Apply the same replacements to rules
  const processRules = (): string => {
    if (!rules) return ''
    return replacePlaceholders(rules)
  }

  return {
    effectiveSystemPrompt,
    processedRules: processRules(),
    isUsingPersonalization:
      personalization.isEnabled && generateUserPreferencesXML().length > 0,
  }
}
