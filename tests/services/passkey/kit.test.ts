import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import {
  createAndWrapTinfoilKey,
  evaluateTinfoilCredential,
  getPasskeyCapability,
  passkeyKeyManager,
  PasskeyTimeoutError,
  PrfNotSupportedError,
  resetPasskeyCapabilityCache,
  TINFOIL_PASSKEY_PROFILE,
  tinfoilPasskeyStorage,
} from '@/services/passkey/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CREDENTIAL_ID = 'AQID'
const PRF_OUTPUT = new Uint8Array(32).map((_, index) => index)
const EXPECTED_KEY = new Uint8Array(32).map((_, index) => 0xff - index)
const originalCredentials = Object.getOwnPropertyDescriptor(
  navigator,
  'credentials',
)
const LEGACY_LOCAL_CREDENTIAL_STORAGE_KEY =
  'tinfoil-local-passkey-credential-id'

function installCredentials(create: () => Promise<unknown>): void {
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(create), get: vi.fn() },
    configurable: true,
  })
}

function installCredentialEvaluation(get: () => Promise<unknown>): void {
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get: vi.fn(get) },
    configurable: true,
  })
}

describe('Tinfoil passkey manager configuration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetPasskeyCapabilityCache()
    vi.restoreAllMocks()
    if (originalCredentials)
      Object.defineProperty(navigator, 'credentials', originalCredentials)
    else Reflect.deleteProperty(navigator, 'credentials')
  })

  it('clears a rejected in-flight capability request', async () => {
    const capability = vi
      .spyOn(passkeyKeyManager, 'capability')
      .mockRejectedValueOnce(new Error('capability unavailable'))
      .mockResolvedValueOnce('supported')

    await expect(getPasskeyCapability()).rejects.toThrow(
      'capability unavailable',
    )
    await expect(getPasskeyCapability()).resolves.toBe('supported')
    expect(capability).toHaveBeenCalledTimes(2)
  })

  it('owns the byte-identical Tinfoil v1 profile', () => {
    expect(TINFOIL_PASSKEY_PROFILE.version).toBe(1)
    expect(new TextDecoder().decode(TINFOIL_PASSKEY_PROFILE.prfSalt)).toBe(
      'tinfoil-chat-key-encryption',
    )
  })

  it('preserves existing cache and local credential storage keys', () => {
    tinfoilPasskeyStorage.saveCachedPRFResult({
      profile: TINFOIL_PASSKEY_PROFILE,
      credentialId: CREDENTIAL_ID,
      prfOutput: PRF_OUTPUT,
    })
    tinfoilPasskeyStorage.saveLocalCredentialId(CREDENTIAL_ID)

    expect(
      JSON.parse(localStorage.getItem(SECRET_PASSKEY_PRF_OUTPUT)!),
    ).toEqual({
      credentialId: CREDENTIAL_ID,
      prfOutput: btoa(String.fromCharCode(...PRF_OUTPUT)),
    })
    expect(tinfoilPasskeyStorage.loadLocalCredentialId()).toBe(CREDENTIAL_ID)
    expect(localStorage.getItem(LEGACY_LOCAL_CREDENTIAL_STORAGE_KEY)).toBe(
      CREDENTIAL_ID,
    )
  })

  it('maps cancellation without inspecting messages', async () => {
    installCredentials(async () => {
      throw new DOMException('localized text', 'NotAllowedError')
    })

    await expect(
      createAndWrapTinfoilKey({
        user: { id: new Uint8Array([1]), name: 'person@example.com' },
        key: EXPECTED_KEY,
      }),
    ).resolves.toBeNull()
    expect(navigator.credentials.create).toHaveBeenCalledOnce()
    const failure = new Error('NotAllowedError: cancelled')
    installCredentials(async () => {
      throw failure
    })
    await expect(
      createAndWrapTinfoilKey({
        user: { id: new Uint8Array([1]), name: 'person@example.com' },
        key: EXPECTED_KEY,
      }),
    ).rejects.toMatchObject({ cause: failure })
  })

  it('maps evaluateCredential cancellation without touching legacy crypto', async () => {
    installCredentialEvaluation(async () => {
      throw new DOMException('localized text', 'NotAllowedError')
    })

    await expect(evaluateTinfoilCredential([CREDENTIAL_ID])).resolves.toBeNull()
    expect(navigator.credentials.get).toHaveBeenCalledOnce()
    expect(navigator.credentials.get).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: expect.objectContaining({
          allowCredentials: [expect.objectContaining({ type: 'public-key' })],
        }),
      }),
    )
    const failure = new Error('NotAllowedError: cancelled')
    installCredentialEvaluation(async () => {
      throw failure
    })
    await expect(
      evaluateTinfoilCredential([CREDENTIAL_ID]),
    ).rejects.toMatchObject({ cause: failure })
  })

  it('maps unsupported and timeout categories to existing UI errors', async () => {
    installCredentials(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
    }))
    await expect(
      createAndWrapTinfoilKey({
        user: { id: new Uint8Array([1]), name: 'person@example.com' },
        key: EXPECTED_KEY,
      }),
    ).rejects.toBeInstanceOf(PrfNotSupportedError)

    vi.useFakeTimers()
    installCredentials(() => new Promise(() => {}))
    const pending = createAndWrapTinfoilKey({
      user: { id: new Uint8Array([1]), name: 'person@example.com' },
      key: EXPECTED_KEY,
    })
    pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).rejects.toBeInstanceOf(PasskeyTimeoutError)
  })
})
