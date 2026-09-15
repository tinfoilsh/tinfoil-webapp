import { getSidebarUpsellVariant } from '@/components/chat/sidebar-upsell-state'
import { describe, expect, it } from 'vitest'

describe('getSidebarUpsellVariant', () => {
  it('shows account benefits to signed-out users', () => {
    expect(
      getSidebarUpsellVariant({
        isAuthLoaded: true,
        isSignedIn: false,
        isSubscriptionLoading: false,
        isPremium: false,
      }),
    ).toBe('account')
  })

  it('shows premium benefits to signed-in free users', () => {
    expect(
      getSidebarUpsellVariant({
        isAuthLoaded: true,
        isSignedIn: true,
        isSubscriptionLoading: false,
        isPremium: false,
      }),
    ).toBe('premium')
  })

  it.each([
    { isAuthLoaded: false, isSubscriptionLoading: false, isPremium: false },
    { isAuthLoaded: true, isSubscriptionLoading: true, isPremium: false },
    { isAuthLoaded: true, isSubscriptionLoading: false, isPremium: true },
  ])(
    'hides the upsell until status is settled or for premium users',
    (state) => {
      expect(
        getSidebarUpsellVariant({
          ...state,
          isSignedIn: true,
        }),
      ).toBeNull()
    },
  )
})
