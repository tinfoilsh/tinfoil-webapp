import { getSidebarUpsellVariant } from '@/components/chat/sidebar-upsell-state'
import { describe, expect, it } from 'vitest'

describe('getSidebarUpsellVariant', () => {
  it.each([
    { isSignedIn: false, variant: 'account' },
    { isSignedIn: true, variant: 'premium' },
  ])(
    'shows $variant benefits for settled users (signed in: $isSignedIn)',
    ({ isSignedIn, variant }) => {
      expect(
        getSidebarUpsellVariant({
          isAuthLoaded: true,
          isSignedIn,
          isSubscriptionLoading: false,
          isPremium: false,
        }),
      ).toBe(variant)
    },
  )

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
