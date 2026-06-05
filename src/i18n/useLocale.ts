import { SETTINGS_UI_LOCALE } from '@/constants/storage-keys'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LOCALE, getDirection, normalizeLocale } from './config'

export interface UseLocaleResult {
  locale: string
  dir: 'ltr' | 'rtl'
  setLocale: (next: string) => void
}

/**
 * Convenience hook for reading the current UI locale and changing it. Changing
 * the locale persists the choice and broadcasts `uiLocaleChanged` so other
 * listeners (e.g. cloud profile sync) can react.
 */
export function useLocale(): UseLocaleResult {
  const { i18n } = useTranslation()
  const locale = normalizeLocale(i18n.language) || DEFAULT_LOCALE

  const setLocale = useCallback(
    (next: string) => {
      const normalized = normalizeLocale(next)
      if (typeof window !== 'undefined') {
        localStorage.setItem(SETTINGS_UI_LOCALE, normalized)
        window.dispatchEvent(
          new CustomEvent('uiLocaleChanged', {
            detail: { locale: normalized },
          }),
        )
      }
      void i18n.changeLanguage(normalized)
    },
    [i18n],
  )

  return { locale, dir: getDirection(locale), setLocale }
}
