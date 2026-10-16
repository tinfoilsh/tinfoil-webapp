import { useChatFontSync } from '@/components/chat/hooks/use-chat-font'
import { useUIState } from '@/components/chat/hooks/use-ui-state'
import {
  SETTINGS_CHAT_FONT,
  SETTINGS_THEME_MODE,
} from '@/constants/storage-keys'
import { publish } from '@/services/harness/runtime'
import { act, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
  document.documentElement.removeAttribute('data-chat-font')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('dark')
  sessionStorage.clear()
})

describe('the theme', () => {
  it('stays the one this device saved until the settings load', () => {
    localStorage.setItem(SETTINGS_THEME_MODE, 'dark')
    publish({ profile: {}, profileReady: false })

    const { result } = renderHook(() => useUIState())

    expect(result.current.themeMode).toBe('dark')
    expect(result.current.isDarkMode).toBe(true)
    expect(document.documentElement).toHaveClass('dark')

    act(() => publish({ profile: { themeMode: 'light' }, profileReady: true }))

    expect(result.current.themeMode).toBe('light')
    expect(result.current.isDarkMode).toBe(false)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem(SETTINGS_THEME_MODE)).toBe('light')
  })
})

describe('the chat font', () => {
  it('is applied from this device before the first paint', () => {
    const attributes = new Map<string, string>()
    const saved: Record<string, string> = {
      [SETTINGS_CHAT_FONT]: 'dyslexic',
    }
    runInNewContext(
      readFileSync(resolve(process.cwd(), 'public/js/boot.js'), 'utf8'),
      {
        localStorage: { getItem: (key: string) => saved[key] ?? null },
        document: {
          documentElement: {
            setAttribute: (name: string, value: string) =>
              attributes.set(name, value),
            classList: { add: () => {}, remove: () => {} },
            style: { setProperty: () => {} },
          },
        },
        window: { matchMedia: () => ({ matches: false }), innerHeight: 800 },
      },
    )

    expect(attributes.get('data-chat-font')).toBe('dyslexic')
  })

  it('stays the one this device saved until the settings load, then is saved', () => {
    document.documentElement.setAttribute('data-chat-font', 'dyslexic')
    publish({ profile: {}, profileReady: false })

    renderHook(() => useChatFontSync())
    expect(document.documentElement).toHaveAttribute(
      'data-chat-font',
      'dyslexic',
    )

    act(() => publish({ profile: { chatFont: 'serif' }, profileReady: true }))

    expect(document.documentElement).toHaveAttribute('data-chat-font', 'serif')
    expect(localStorage.getItem(SETTINGS_CHAT_FONT)).toBe('serif')
  })
})
