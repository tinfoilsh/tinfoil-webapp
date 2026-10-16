import { resetPasskeyCapabilityCache } from '@/services/passkey/kit'
import { isPrfSupported } from '@/services/passkey/prf-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('prf-support', () => {
  const originalPublicKeyCredential = globalThis.PublicKeyCredential
  const originalCredentials = navigator.credentials

  beforeEach(() => {
    resetPasskeyCapabilityCache()
    Object.defineProperty(navigator, 'credentials', {
      value: { create: vi.fn(), get: vi.fn() },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    // Restore original — always run even if the original was undefined,
    // otherwise a test that defines PublicKeyCredential will leak it.
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      value: originalPublicKeyCredential,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(navigator, 'credentials', {
      value: originalCredentials,
      writable: true,
      configurable: true,
    })
    vi.restoreAllMocks()
  })

  it('should return false when PublicKeyCredential is not available', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    const result = await isPrfSupported()
    expect(result).toBe(false)
  })

  it('should return true when platform authenticator is available (optimistic)', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi
          .fn()
          .mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    })

    const result = await isPrfSupported()
    expect(result).toBe(true)
  })
})
