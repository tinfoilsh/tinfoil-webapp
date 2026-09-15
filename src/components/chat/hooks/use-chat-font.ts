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
 * Keeps the data-chat-font attribute on <html> in sync with the saved
 * setting. The attribute is first set before paint by an inline script in
 * _document.tsx; elements using the `font-chat` class pick the font up from
 * CSS (see globals.css), so no per-component state is needed.
 */
export const useChatFontSync = () => {
  useEffect(() => {
    const update = () =>
      applyChatFont(normalizeChatFont(getView().profile.chatFont))
    update()
    return subscribe(update)
  }, [])
}
