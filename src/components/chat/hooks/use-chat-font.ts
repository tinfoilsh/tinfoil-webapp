import { SETTINGS_CHAT_FONT } from '@/constants/storage-keys'
import { getView, subscribe } from '@/services/harness/runtime'
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
 * Keeps the data-chat-font attribute on <html> in sync with the profile
 * setting loaded from the chat service. Elements using the `font-chat` class
 * pick the font up from CSS (see globals.css), so no per-component state is
 * needed. The font is also kept on the device, where public/js/boot.js
 * applies it before the first paint; until the settings load, that font
 * stays.
 */
export const useChatFontSync = () => {
  useEffect(() => {
    let applied: ChatFont | undefined
    const update = () => {
      const { profile, profileReady } = getView()
      if (!profileReady) return
      const font = normalizeChatFont(profile.chatFont)
      if (font === applied) return
      applied = font
      applyChatFont(font)
      try {
        localStorage.setItem(SETTINGS_CHAT_FONT, font)
      } catch {
        // Storage can be blocked; the next page load starts with the default.
      }
    }
    update()
    return subscribe(update)
  }, [])
}
