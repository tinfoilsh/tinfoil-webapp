import { hasActiveSubscription } from '@/hooks/use-subscription-status'
import { describe, expect, it } from 'vitest'

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
