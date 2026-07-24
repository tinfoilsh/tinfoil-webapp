import { SETTINGS_CHAT_FONT } from '@/constants/storage-keys'
import { useEffect } from 'react'

export type ChatFont = 'system' | 'serif' | 'mono' | 'dyslexic'

export const normalizeChatFont = (
  value: string | null | undefined,
): ChatFont => {
  if (value === 'serif' || value === 'mono' || value === 'dyslexic') {
    return value
  }

  return 'system'
}

const applyChatFont = (font: ChatFont) => {
  document.documentElement.setAttribute('data-chat-font', font)
}

/**
 * Keeps the data-chat-font attribute on <html> in sync with the saved
 * setting. The attribute is first set before paint by an inline script in
 * _document.tsx; elements using the `font-chat` class pick the font up from
 * CSS (see globals.css), so no per-component state is needed.
 */
export const useChatFontSync = () => {
  useEffect(() => {
    applyChatFont(normalizeChatFont(localStorage.getItem(SETTINGS_CHAT_FONT)))

    const handleStorageChange = (e: StorageEvent | CustomEvent) => {
      let key: string | null = null
      let newValue: string | null = null

      if (e instanceof StorageEvent) {
        key = e.key
        newValue = e.newValue
      } else if (e.type === 'chatFontChanged') {
        key = SETTINGS_CHAT_FONT
        newValue = (e as CustomEvent).detail
      }

      if (key === SETTINGS_CHAT_FONT) {
        applyChatFont(normalizeChatFont(newValue))
      }
    }

    window.addEventListener('storage', handleStorageChange)
    window.addEventListener(
      'chatFontChanged',
      handleStorageChange as EventListener,
    )
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener(
        'chatFontChanged',
        handleStorageChange as EventListener,
      )
    }
  }, [])
}
