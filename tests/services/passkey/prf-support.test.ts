import {
  isPrfSupported,
  resetPrfSupportCache,
} from '@/services/passkey/prf-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('prf-support', () => {
  const originalPublicKeyCredential = globalThis.PublicKeyCredential
  const originalCredentials = navigator.credentials

  beforeEach(() => {
    resetPrfSupportCache()
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

  it('should return false when platform authenticator is not available', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi
          .fn()
          .mockResolvedValue(false),
      },
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

  it('should return true when getClientCapabilities reports PRF support', async () => {
    const getClientCapabilities = vi
      .fn()
      .mockResolvedValue({ 'extension:prf': true })
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi
          .fn()
          .mockResolvedValue(true),
        getClientCapabilities,
      },
      writable: true,
      configurable: true,
    })

    const result = await isPrfSupported()
    expect(result).toBe(true)
    expect(getClientCapabilities).toHaveBeenCalledOnce()
  })

  it('should return false when client capabilities report no PRF support', async () => {
    const getClientCapabilities = vi
      .fn()
      .mockResolvedValue({ 'extension:prf': false })
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi
          .fn()
          .mockResolvedValue(true),
        getClientCapabilities,
      },
      writable: true,
      configurable: true,
    })

    await expect(isPrfSupported()).resolves.toBe(false)
    expect(getClientCapabilities).toHaveBeenCalledOnce()
  })

  it('should remain optimistic when the PRF capability is omitted', async () => {
    const getClientCapabilities = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi
          .fn()
          .mockResolvedValue(true),
        getClientCapabilities,
      },
      writable: true,
      configurable: true,
    })

    await expect(isPrfSupported()).resolves.toBe(true)
    expect(getClientCapabilities).toHaveBeenCalledOnce()
  })

  it('should share one in-flight capability request', async () => {
    const mockAvailable = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: mockAvailable,
      },
      writable: true,
      configurable: true,
    })

    const [result1, result2] = await Promise.all([
      isPrfSupported(),
      isPrfSupported(),
    ])

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(mockAvailable).toHaveBeenCalledTimes(1)
  })

  it('should reset cache when resetPrfSupportCache is called', async () => {
    const mockAvailable = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: mockAvailable,
      },
      writable: true,
      configurable: true,
    })

    await isPrfSupported()
    expect(mockAvailable).toHaveBeenCalledTimes(1)

    resetPrfSupportCache()
    await isPrfSupported()
    expect(mockAvailable).toHaveBeenCalledTimes(2)
  })
})
