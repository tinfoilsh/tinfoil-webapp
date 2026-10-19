import { useAutoIntelligence } from '@/components/chat/hooks/use-auto-intelligence'
import { SETTINGS_AUTO_INTELLIGENCE } from '@/constants/storage-keys'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

describe('useAutoIntelligence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts at the default level when nothing is saved', () => {
    const { result } = renderHook(() => useAutoIntelligence())
    expect(result.current.autoIntelligence).toBe('high')
  })

  it('reads a saved level on first render and ignores garbage', () => {
    localStorage.setItem(SETTINGS_AUTO_INTELLIGENCE, 'max')
    expect(
      renderHook(() => useAutoIntelligence()).result.current.autoIntelligence,
    ).toBe('max')

    localStorage.setItem(SETTINGS_AUTO_INTELLIGENCE, 'smart')
    expect(
      renderHook(() => useAutoIntelligence()).result.current.autoIntelligence,
    ).toBe('high')
  })

  it('persists changes and syncs every mounted instance', () => {
    const first = renderHook(() => useAutoIntelligence())
    const second = renderHook(() => useAutoIntelligence())

    act(() => {
      first.result.current.setAutoIntelligence('low')
    })

    expect(localStorage.getItem(SETTINGS_AUTO_INTELLIGENCE)).toBe('low')
    expect(first.result.current.autoIntelligence).toBe('low')
    expect(second.result.current.autoIntelligence).toBe('low')
  })

  it('follows changes made in another tab and resets when storage is cleared', () => {
    const { result } = renderHook(() => useAutoIntelligence())

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SETTINGS_AUTO_INTELLIGENCE,
          newValue: 'max',
        }),
      )
    })
    expect(result.current.autoIntelligence).toBe('max')

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'unrelated', newValue: 'low' }),
      )
    })
    expect(result.current.autoIntelligence).toBe('max')

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })
    expect(result.current.autoIntelligence).toBe('high')
  })
})
