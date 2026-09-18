import { UrlHashSettingsHandler } from '@/components/url-hash-settings-handler'
import { SETTINGS_TABS } from '@/constants/settings-tabs'
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

  it.each(SETTINGS_TABS)('recognizes the shared %s tab value', (tab) => {
    window.history.replaceState(null, '', `/#settings/${tab}`)
    const onSettingsTabReady = vi.fn()
    render(
      <UrlHashSettingsHandler
        isReady
        onSettingsTabReady={onSettingsTabReady}
      />,
    )
    expect(onSettingsTabReady).toHaveBeenCalledExactlyOnceWith(tab)
  })

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

  it.each([
    ['data', 'data'],
    ['import', 'data'],
    ['export', 'data'],
    ['safeguards', 'safeguards'],
  ])('opens the %s link in the %s tab', (link, tab) => {
    window.history.replaceState(null, '', `/#settings/${link}`)
    const onSettingsTabReady = vi.fn()
    render(
      <UrlHashSettingsHandler
        isReady
        onSettingsTabReady={onSettingsTabReady}
      />,
    )
    expect(onSettingsTabReady).toHaveBeenCalledExactlyOnceWith(tab)
    expect(window.location.hash).toBe('')
  })
})
