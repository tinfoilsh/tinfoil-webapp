// Central configuration for UI localization.
//
// Adding a new language is intentionally a two-step change:
//   1. Add an entry to LOCALES below.
//   2. Create src/i18n/locales/<code>/<namespace>.json for every namespace.
// Everything else (detection, lazy loading, the language picker, RTL handling)
// is driven off this list.

export type LocaleDirection = 'ltr' | 'rtl'

export interface LocaleConfig {
  /** BCP-47 code used as the i18next language and locale folder name. */
  code: string
  /** Native name shown in the language picker (endonym). */
  label: string
  /** English name, useful for search and accessibility. */
  englishName: string
  dir: LocaleDirection
}

export const DEFAULT_LOCALE = 'en'

export const LOCALES: LocaleConfig[] = [
  { code: 'en', label: 'English', englishName: 'English', dir: 'ltr' },
  {
    code: 'zh-Hans',
    label: '简体中文',
    englishName: 'Chinese (Simplified)',
    dir: 'ltr',
  },
  { code: 'es', label: 'Español', englishName: 'Spanish', dir: 'ltr' },
  { code: 'hi', label: 'हिन्दी', englishName: 'Hindi', dir: 'ltr' },
  { code: 'ar', label: 'العربية', englishName: 'Arabic', dir: 'rtl' },
  { code: 'fr', label: 'Français', englishName: 'French', dir: 'ltr' },
  { code: 'bn', label: 'বাংলা', englishName: 'Bengali', dir: 'ltr' },
  {
    code: 'pt-BR',
    label: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    dir: 'ltr',
  },
  { code: 'ru', label: 'Русский', englishName: 'Russian', dir: 'ltr' },
  { code: 'ur', label: 'اردو', englishName: 'Urdu', dir: 'rtl' },
  {
    code: 'id',
    label: 'Bahasa Indonesia',
    englishName: 'Indonesian',
    dir: 'ltr',
  },
  { code: 'de', label: 'Deutsch', englishName: 'German', dir: 'ltr' },
  { code: 'ja', label: '日本語', englishName: 'Japanese', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', englishName: 'Turkish', dir: 'ltr' },
  { code: 'ko', label: '한국어', englishName: 'Korean', dir: 'ltr' },
  { code: 'vi', label: 'Tiếng Việt', englishName: 'Vietnamese', dir: 'ltr' },
  { code: 'it', label: 'Italiano', englishName: 'Italian', dir: 'ltr' },
  { code: 'th', label: 'ไทย', englishName: 'Thai', dir: 'ltr' },
  { code: 'pl', label: 'Polski', englishName: 'Polish', dir: 'ltr' },
  { code: 'nl', label: 'Nederlands', englishName: 'Dutch', dir: 'ltr' },
  { code: 'fa', label: 'فارسی', englishName: 'Persian', dir: 'rtl' },
  { code: 'uk', label: 'Українська', englishName: 'Ukrainian', dir: 'ltr' },
  { code: 'ta', label: 'தமிழ்', englishName: 'Tamil', dir: 'ltr' },
  {
    code: 'zh-Hant',
    label: '繁體中文',
    englishName: 'Chinese (Traditional)',
    dir: 'ltr',
  },
  { code: 'fil', label: 'Filipino', englishName: 'Filipino', dir: 'ltr' },
]

export const LOCALE_CODES: string[] = LOCALES.map((l) => l.code)

export const NAMESPACES = ['common', 'chat', 'sidebar', 'settings'] as const
export type Namespace = (typeof NAMESPACES)[number]
export const DEFAULT_NAMESPACE: Namespace = 'common'

export const RTL_LOCALES: string[] = LOCALES.filter((l) => l.dir === 'rtl').map(
  (l) => l.code,
)

/**
 * Maps an arbitrary BCP-47 tag (e.g. from navigator.language) onto one of the
 * shipped locale codes, or falls back to the default. Handles script/region
 * variants so that, e.g., `en-US` resolves to `en` and `zh-TW` to `zh-Hant`.
 */
export function normalizeLocale(input?: string | null): string {
  if (!input) return DEFAULT_LOCALE
  const raw = input.trim()
  if (!raw) return DEFAULT_LOCALE
  const lower = raw.toLowerCase()

  // Chinese is split by script rather than region.
  if (lower.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh-Hans'
  }
  // Only Brazilian Portuguese is shipped.
  if (lower.startsWith('pt')) return 'pt-BR'

  const exact = LOCALE_CODES.find((c) => c.toLowerCase() === lower)
  if (exact) return exact

  const base = lower.split('-')[0]
  // Filipino is frequently reported as `tl` (Tagalog).
  if (base === 'tl') return 'fil'

  const baseMatch = LOCALE_CODES.find((c) => c.toLowerCase() === base)
  if (baseMatch) return baseMatch

  return DEFAULT_LOCALE
}

export function getDirection(locale: string): LocaleDirection {
  return RTL_LOCALES.includes(normalizeLocale(locale)) ? 'rtl' : 'ltr'
}
