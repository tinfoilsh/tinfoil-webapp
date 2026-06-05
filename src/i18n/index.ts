import { SETTINGS_UI_LOCALE } from '@/constants/storage-keys'
import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import resourcesToBackend from 'i18next-resources-to-backend'
import { initReactI18next } from 'react-i18next'
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  LOCALE_CODES,
  NAMESPACES,
  normalizeLocale,
} from './config'
import enChat from './locales/en/chat.json'
import enCommon from './locales/en/common.json'
import enSettings from './locales/en/settings.json'
import enSidebar from './locales/en/sidebar.json'

const isBrowser = typeof window !== 'undefined'

// English is bundled eagerly so the default/fallback language renders with zero
// flash; every other locale is fetched on demand as a separate chunk via the
// resources-to-backend loader below.
const bundledResources = {
  en: {
    common: enCommon,
    chat: enChat,
    sidebar: enSidebar,
    settings: enSettings,
  },
} as const

export const i18nInitPromise = i18n
  .use(
    resourcesToBackend(
      (language: string, namespace: string) =>
        import(`./locales/${language}/${namespace}.json`),
    ),
  )
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: bundledResources,
    partialBundledLanguages: true,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALE_CODES,
    nonExplicitSupportedLngs: false,
    load: 'currentOnly',
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: SETTINGS_UI_LOCALE,
      caches: isBrowser ? ['localStorage'] : [],
      convertDetectedLanguage: normalizeLocale,
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    // During static export there is no detector input, so prerendered HTML is
    // produced in the default language and corrected on the client.
    ...(isBrowser ? {} : { lng: DEFAULT_LOCALE }),
  })

export default i18n
