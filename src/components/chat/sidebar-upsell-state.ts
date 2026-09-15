export type SidebarUpsellVariant = 'account' | 'premium' | null

type SidebarUpsellState = {
  isAuthLoaded: boolean
  isSignedIn: boolean | undefined
  isSubscriptionLoading: boolean
  isPremium: boolean
}

export function getSidebarUpsellVariant({
  isAuthLoaded,
  isSignedIn,
  isSubscriptionLoading,
  isPremium,
}: SidebarUpsellState): SidebarUpsellVariant {
  if (!isAuthLoaded || isSubscriptionLoading || isPremium) return null
  return isSignedIn ? 'premium' : 'account'
}
