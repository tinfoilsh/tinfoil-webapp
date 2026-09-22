import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CACHED_SUBSCRIPTION_STATUS,
} from '@/constants/storage-keys'
import {
  hasActiveSubscription,
  readCachedSubscriptionStatus,
  useSubscriptionStatus,
} from '@/hooks/use-subscription-status'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clerkState = vi.hoisted(() => ({
  isLoaded: false,
  user: null as null | { id: string; publicMetadata: Record<string, unknown> },
}))

vi.mock('@clerk/react', () => ({
  useUser: () => clerkState,
}))

describe('hasActiveSubscription', () => {
  const now = new Date('2026-07-23T12:00:00Z')
  const future = new Date('2026-08-23T12:00:00Z')
  const past = new Date('2026-07-22T12:00:00Z')

  it('allows active subscriptions without a cutoff', () => {
    expect(hasActiveSubscription('active', null, now)).toBe(true)
  })

  it('allows active subscriptions before their cutoff', () => {
    expect(hasActiveSubscription('active', future, now)).toBe(true)
  })

  it('rejects active subscriptions after their cutoff', () => {
    expect(hasActiveSubscription('active', past, now)).toBe(false)
  })

  it('allows trialing subscriptions with or without a future cutoff', () => {
    expect(hasActiveSubscription('trialing', null, now)).toBe(true)
    expect(hasActiveSubscription('trialing', future, now)).toBe(true)
  })

  it('allows canceled subscriptions before their cutoff', () => {
    expect(hasActiveSubscription('canceled', future, now)).toBe(true)
  })

  it('rejects canceled subscriptions without a future cutoff', () => {
    expect(hasActiveSubscription('canceled', null, now)).toBe(false)
    expect(hasActiveSubscription('canceled', past, now)).toBe(false)
  })
})

describe('readCachedSubscriptionStatus', () => {
  const now = new Date('2026-07-23T12:00:00Z').getTime()

  beforeEach(() => localStorage.clear())

  it('restores a recent cache for the same user', () => {
    localStorage.setItem(
      SETTINGS_CACHED_SUBSCRIPTION_STATUS,
      JSON.stringify({
        userId: 'user_123',
        chat_subscription_active: true,
        cachedAt: now,
      }),
    )

    expect(readCachedSubscriptionStatus('user_123', now)).toBe(true)
  })

  it('rejects another user or an expired cache', () => {
    localStorage.setItem(
      SETTINGS_CACHED_SUBSCRIPTION_STATUS,
      JSON.stringify({
        userId: 'user_123',
        chat_subscription_active: true,
        cachedAt: now - 25 * 60 * 60 * 1000,
      }),
    )

    expect(readCachedSubscriptionStatus('user_456', now)).toBeNull()
    expect(readCachedSubscriptionStatus('user_123', now)).toBeNull()
  })
})

describe('useSubscriptionStatus cache synchronization', () => {
  beforeEach(() => {
    localStorage.clear()
    clerkState.isLoaded = false
    clerkState.user = null
  })

  afterEach(() => vi.restoreAllMocks())

  it('re-reads cached status when the active user changes', () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(
      SETTINGS_CACHED_SUBSCRIPTION_STATUS,
      JSON.stringify({
        userId: 'user_123',
        chat_subscription_active: true,
        cachedAt: Date.now(),
      }),
    )
    const { result } = renderHook(() => useSubscriptionStatus())

    expect(result.current.chat_subscription_active).toBe(true)

    act(() => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_456')
      window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    })

    expect(result.current.chat_subscription_active).toBe(false)
  })

  it('re-reads cached status after cross-tab storage changes', () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(
      SETTINGS_CACHED_SUBSCRIPTION_STATUS,
      JSON.stringify({
        userId: 'user_123',
        chat_subscription_active: true,
        cachedAt: Date.now(),
      }),
    )
    const { result } = renderHook(() => useSubscriptionStatus())

    act(() => {
      localStorage.setItem(
        SETTINGS_CACHED_SUBSCRIPTION_STATUS,
        JSON.stringify({
          userId: 'user_123',
          chat_subscription_active: false,
          cachedAt: Date.now(),
        }),
      )
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SETTINGS_CACHED_SUBSCRIPTION_STATUS,
        }),
      )
    })
    expect(result.current.chat_subscription_active).toBe(false)

    act(() => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_456')
      localStorage.setItem(
        SETTINGS_CACHED_SUBSCRIPTION_STATUS,
        JSON.stringify({
          userId: 'user_456',
          chat_subscription_active: true,
          cachedAt: Date.now(),
        }),
      )
      window.dispatchEvent(
        new StorageEvent('storage', { key: AUTH_ACTIVE_USER_ID }),
      )
    })
    expect(result.current.chat_subscription_active).toBe(true)
  })

  it('falls back safely when browser storage is unavailable', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })

    const { result } = renderHook(() => useSubscriptionStatus())

    expect(result.current.chat_subscription_active).toBe(false)
  })
})
