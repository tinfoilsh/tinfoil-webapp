'use client'

import { type ReactNode, useEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDirection } from './config'
import i18n, { i18nInitPromise } from './index'

function applyDocumentLocale(locale: string) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.documentElement.dir = getDirection(locale)
}

/**
 * Wires the shared i18next instance into the React tree and keeps the
 * document's lang/dir attributes in sync with the active locale. The pre-paint
 * script in _document handles the stored preference before hydration; this
 * provider additionally covers browser-detected locales and runtime changes.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    i18nInitPromise
      .then(() => applyDocumentLocale(i18n.language))
      .catch(() => {})

    const handleLanguageChanged = (lng: string) => applyDocumentLocale(lng)
    i18n.on('languageChanged', handleLanguageChanged)

    const handleUiLocaleChanged = (event: Event) => {
      const next = (event as CustomEvent).detail?.locale
      if (next && next !== i18n.language) {
        void i18n.changeLanguage(next)
      }
    }
    window.addEventListener(
      'uiLocaleChanged',
      handleUiLocaleChanged as EventListener,
    )

    return () => {
      i18n.off('languageChanged', handleLanguageChanged)
      window.removeEventListener(
        'uiLocaleChanged',
        handleUiLocaleChanged as EventListener,
      )
    }
  }, [])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
