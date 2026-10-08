import { UrlHashSettingsHandler } from '@/components/url-hash-settings-handler'
import { logWarning } from '@/utils/error-handling'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

describe('settings deep links', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.clearAllMocks()
  })

  it('preserves an unknown settings link without opening a tab', () => {
    window.history.replaceState(null, '', '/#settings/unknown')
    const onSettingsTabReady = vi.fn()
    render(
      <UrlHashSettingsHandler
        isReady
        onSettingsTabReady={onSettingsTabReady}
      />,
    )
    expect(onSettingsTabReady).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#settings/unknown')
    expect(logWarning).toHaveBeenCalledWith(
      'Invalid settings tab in URL fragment',
      {
        component: 'UrlHashSettingsHandler',
        metadata: { tabName: 'unknown' },
      },
    )
  })

  it.each([
    ['general', 'general'],
    ['chat', 'chat'],
    ['personalization', 'personalization'],
    ['prompts', 'prompts'],
    ['cloud-sync', 'cloud-sync'],
    ['safeguards', 'safeguards'],
    ['data', 'data'],
    ['account', 'account'],
    ['import', 'data'],
    ['export', 'data'],
  ])(
    'opens the %s link in the %s tab and consumes its fragment',
    (link, tab) => {
      window.history.replaceState(
        null,
        '',
        `/chat?view=compact#settings/${link}`,
      )
      const onSettingsTabReady = vi.fn()
      render(
        <UrlHashSettingsHandler
          isReady
          onSettingsTabReady={onSettingsTabReady}
        />,
      )
      expect(onSettingsTabReady).toHaveBeenCalledExactlyOnceWith(tab)
      expect(window.location.pathname).toBe('/chat')
      expect(window.location.search).toBe('?view=compact')
      expect(window.location.hash).toBe('')
    },
  )

  it('preserves a safeguards link until the app and authentication are ready', () => {
    window.history.replaceState(null, '', '/#settings/safeguards')
    const onSettingsTabReady = vi.fn()
    const { rerender } = render(
      <UrlHashSettingsHandler
        isReady={false}
        onSettingsTabReady={onSettingsTabReady}
      />,
    )
    expect(onSettingsTabReady).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#settings/safeguards')
    rerender(
      <UrlHashSettingsHandler
        isReady
        onSettingsTabReady={onSettingsTabReady}
      />,
    )
    expect(onSettingsTabReady).toHaveBeenCalledExactlyOnceWith('safeguards')
  })
})
