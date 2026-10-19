export const SYSTEM_RESPONSE_LANGUAGE = 'System'

export const RESPONSE_LANGUAGES = [
  SYSTEM_RESPONSE_LANGUAGE,
  ...[
    'Afrikaans',
    'Albanian',
    'Arabic',
    'Armenian',
    'Azerbaijani',
    'Basque',
    'Belarusian',
    'Bengali',
    'Bosnian',
    'Bulgarian',
    'Catalan',
    'Chinese (Simplified)',
    'Chinese (Traditional)',
    'Croatian',
    'Czech',
    'Danish',
    'Dutch',
    'English',
    'Estonian',
    'Filipino',
    'Finnish',
    'French',
    'Galician',
    'Georgian',
    'German',
    'Greek',
    'Gujarati',
    'Haitian Creole',
    'Hebrew',
    'Hindi',
    'Hungarian',
    'Icelandic',
    'Indonesian',
    'Irish',
    'Italian',
    'Japanese',
    'Kannada',
    'Kazakh',
    'Korean',
    'Latin',
    'Latvian',
    'Lithuanian',
    'Macedonian',
    'Malay',
    'Malayalam',
    'Maltese',
    'Marathi',
    'Mongolian',
    'Norwegian',
    'Persian',
    'Polish',
    'Portuguese',
    'Romanian',
    'Russian',
    'Serbian',
    'Slovak',
    'Slovenian',
    'Spanish',
    'Swahili',
    'Swedish',
    'Tamil',
    'Telugu',
    'Thai',
    'Turkish',
    'Ukrainian',
    'Urdu',
    'Uzbek',
    'Vietnamese',
    'Welsh',
    'Yiddish',
  ].sort(),
] as const

export function normalizeResponseLanguage(
  language: string | null | undefined,
): string {
  return language && language.trim() ? language : SYSTEM_RESPONSE_LANGUAGE
}

export function resolveResponseLanguage(
  language: string | null | undefined,
  locales?: readonly string[],
): string {
  const normalized = normalizeResponseLanguage(language)
  if (normalized !== SYSTEM_RESPONSE_LANGUAGE) return normalized

  const browserLocales =
    locales ??
    (typeof navigator === 'undefined'
      ? []
      : [...navigator.languages, navigator.language])
  const locale = browserLocales.find((candidate) => candidate.trim())
  if (!locale) return 'English'

  try {
    const canonicalLocale = Intl.getCanonicalLocales(
      locale.replace('_', '-'),
    )[0]
    return (
      new Intl.DisplayNames(['en'], { type: 'language' }).of(canonicalLocale) ??
      'English'
    )
  } catch {
    return 'English'
  }
}
