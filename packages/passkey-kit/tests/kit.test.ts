import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64Url } from '../src/codec'
import { CEK_BYTES } from '../src/crypto'
import { PasskeyTimeoutError, PrfNotSupportedError } from '../src/errors'
import { createPasskeyKit } from '../src/kit'
import { createMemoryStorageAdapter } from '../src/storage'

const originalCredentials = navigator.credentials

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(navigator, 'credentials', {
    value: originalCredentials,
    writable: true,
    configurable: true,
  })
})

function installCredentialsMock(stub: {
  create?: (...args: unknown[]) => unknown
  get?: (...args: unknown[]) => unknown
}): void {
  Object.defineProperty(navigator, 'credentials', {
    value: stub,
    writable: true,
    configurable: true,
  })
}

function fakeCredential(options: {
  rawId?: ArrayBuffer
  prfEnabled?: boolean
  prfFirst?: ArrayBuffer | null
  attachment?: string | null
}): PublicKeyCredential {
  const rawId =
    options.rawId ??
    (crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer)
  return {
    rawId,
    authenticatorAttachment: options.attachment ?? null,
    getClientExtensionResults: () => {
      if (!options.prfEnabled && !options.prfFirst) return {}
      const prf: { enabled?: boolean; results?: { first: ArrayBuffer } } = {}
      if (options.prfEnabled) prf.enabled = true
      if (options.prfFirst) prf.results = { first: options.prfFirst }
      return { prf }
    },
  } as unknown as PublicKeyCredential
}

function makeKit(storage = createMemoryStorageAdapter()) {
  return {
    kit: createPasskeyKit({
      rpId: 'example.com',
      rpName: 'Example',
      storage,
    }),
    storage,
  }
}

describe('createPasskey', () => {
  it('returns the PRF result and caches it when creation yields PRF output', async () => {
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    const rawId = crypto.getRandomValues(new Uint8Array(16))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({
          rawId,
          prfEnabled: true,
          prfFirst,
          attachment: 'platform',
        }),
      ),
    })

    const { kit } = makeKit()
    const result = await kit.createPasskey({ id: 'u1', name: 'u@example.com' })

    expect(result?.credentialId).toBe(bytesToBase64Url(new Uint8Array(rawId)))
    expect(result?.prfOutput.byteLength).toBe(32)

    const cached = kit.getCachedPrfResult()
    expect(cached?.credentialId).toBe(result?.credentialId)
    expect(new Uint8Array(cached!.prfOutput)).toEqual(new Uint8Array(prfFirst))
    expect(kit.getLocalCredentialId()).toBe(result?.credentialId)
  })

  it('does not remember the credential id for cross-platform authenticators', async () => {
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({
          prfEnabled: true,
          prfFirst,
          attachment: 'cross-platform',
        }),
      ),
    })

    const { kit } = makeKit()
    const result = await kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    expect(result).not.toBeNull()
    expect(kit.getLocalCredentialId()).toBeNull()
    expect(kit.getCachedPrfResult()).not.toBeNull()
  })

  it('falls back to an immediate assertion when creation reports PRF but no output', async () => {
    const rawId = crypto.getRandomValues(new Uint8Array(16))
      .buffer as ArrayBuffer
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({ rawId, prfEnabled: true, prfFirst: null }),
      ),
      get: vi.fn(async () => fakeCredential({ rawId, prfFirst })),
    })

    const { kit } = makeKit()
    const result = await kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    expect(result?.credentialId).toBe(bytesToBase64Url(new Uint8Array(rawId)))
  })

  it('throws PrfNotSupportedError when the authenticator lacks PRF', async () => {
    installCredentialsMock({
      create: vi.fn(async () => fakeCredential({ prfEnabled: false })),
    })

    const { kit } = makeKit()
    await expect(
      kit.createPasskey({ id: 'u1', name: 'u@example.com' }),
    ).rejects.toBeInstanceOf(PrfNotSupportedError)
  })

  it('uses a brand-neutral default message and honors errorMessages overrides', async () => {
    installCredentialsMock({
      create: vi.fn(async () => fakeCredential({ prfEnabled: false })),
    })

    const { kit } = makeKit()
    const defaultError = await kit
      .createPasskey({ id: 'u1', name: 'u@example.com' })
      .catch((error: unknown) => error as Error)
    expect((defaultError as Error).message).toContain('this app')

    const branded = createPasskeyKit({
      rpId: 'example.com',
      rpName: 'Example',
      storage: createMemoryStorageAdapter(),
      errorMessages: { prfNotSupported: 'Example App needs PRF support.' },
    })
    const brandedError = await branded
      .createPasskey({ id: 'u1', name: 'u@example.com' })
      .catch((error: unknown) => error as Error)
    expect(brandedError).toBeInstanceOf(PrfNotSupportedError)
    expect((brandedError as Error).message).toBe(
      'Example App needs PRF support.',
    )
  })

  it('honors the errorMessages timeout override when the provider hangs', async () => {
    vi.useFakeTimers()
    installCredentialsMock({ create: vi.fn(() => new Promise(() => {})) })

    const kit = createPasskeyKit({
      rpId: 'example.com',
      rpName: 'Example',
      storage: createMemoryStorageAdapter(),
      errorMessages: { timeout: 'Example App timed out.' },
    })
    const promise = kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(promise).rejects.toMatchObject({
      name: 'PasskeyTimeoutError',
      message: 'Example App timed out.',
    })
  })

  it('returns null when the user cancels', async () => {
    installCredentialsMock({
      create: vi.fn(async () => {
        throw new DOMException('User cancelled', 'NotAllowedError')
      }),
    })

    const { kit } = makeKit()
    await expect(
      kit.createPasskey({ id: 'u1', name: 'u@example.com' }),
    ).resolves.toBeNull()
  })

  it('throws PasskeyTimeoutError when the provider hangs', async () => {
    vi.useFakeTimers()
    installCredentialsMock({ create: vi.fn(() => new Promise(() => {})) })

    const { kit } = makeKit()
    const promise = kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(promise).rejects.toBeInstanceOf(PasskeyTimeoutError)
  })
})

describe('enroll and unlock', () => {
  /**
   * Install a PRF-capable credentials mock and enroll a fresh CEK on a new
   * kit. Returns the `get` spy so tests can assert whether a ceremony ran.
   */
  async function enrollWithMock() {
    const rawId = crypto.getRandomValues(new Uint8Array(16))
      .buffer as ArrayBuffer
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    const get = vi.fn(async () =>
      fakeCredential({ rawId, prfFirst: prfFirst.slice(0) }),
    )
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({
          rawId,
          prfEnabled: true,
          prfFirst: prfFirst.slice(0),
        }),
      ),
      get,
    })

    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const { kit } = makeKit()
    const enrolled = await kit.enroll({
      user: { id: 'u1', name: 'u@example.com' },
      cek,
    })
    expect(enrolled).not.toBeNull()
    return { kit, cek, enrolled: enrolled!, get }
  }

  it('round-trips a CEK through enroll → unlock', async () => {
    const { kit, cek, enrolled } = await enrollWithMock()
    expect(enrolled.wrappedCek.credentialId).toBe(enrolled.credentialId)

    const unlocked = await kit.unlock([enrolled.wrappedCek])
    expect(unlocked?.credentialId).toBe(enrolled.credentialId)
    expect(unlocked?.cek).toEqual(cek)
  })

  it('returns null from unlock when there is nothing to unwrap', async () => {
    const { kit } = makeKit()
    await expect(kit.unlock([])).resolves.toBeNull()
  })

  it('rewraps with the cached PRF output without prompting', async () => {
    const { kit, enrolled, get } = await enrollWithMock()

    const newCek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const rewrapped = await kit.rewrapWithCachedPrf(newCek)
    expect(rewrapped).not.toBeNull()
    expect(get).not.toHaveBeenCalled()

    const unlocked = await kit.unlock([rewrapped!])
    expect(unlocked?.cek).toEqual(newCek)
    expect(enrolled.credentialId).toBe(rewrapped!.credentialId)
  })

  it('returns null from rewrapWithCachedPrf when nothing is cached', async () => {
    const { kit } = makeKit()
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    await expect(kit.rewrapWithCachedPrf(cek)).resolves.toBeNull()
  })

  it('unlocks with the cached PRF output without prompting', async () => {
    const { kit, cek, enrolled, get } = await enrollWithMock()

    const unlocked = await kit.unlockWithCachedPrf([enrolled.wrappedCek])
    expect(unlocked?.credentialId).toBe(enrolled.credentialId)
    expect(unlocked?.cek).toEqual(cek)
    expect(get).not.toHaveBeenCalled()
  })

  it('returns null from unlockWithCachedPrf when nothing is cached or nothing matches', async () => {
    const stranger = {
      credentialId: 'someone-else',
      kekIvHex: '00'.repeat(12),
      wrappedKeyHex: '00'.repeat(48),
    }

    const { kit: emptyKit } = makeKit()
    await expect(emptyKit.unlockWithCachedPrf([stranger])).resolves.toBeNull()

    const { kit } = await enrollWithMock()
    await expect(kit.unlockWithCachedPrf([stranger])).resolves.toBeNull()
  })

  it('returns null from unlockWithCachedPrf when the wrapped CEK is tampered', async () => {
    const { kit, enrolled } = await enrollWithMock()

    const tampered = {
      ...enrolled.wrappedCek,
      wrappedKeyHex: '00'.repeat(48),
    }
    await expect(kit.unlockWithCachedPrf([tampered])).resolves.toBeNull()
  })

  it('rewraps with the cached PRF output when destructured off the kit', async () => {
    const { kit, cek, enrolled } = await enrollWithMock()

    const { rewrapWithCachedPrf } = kit
    const rewrapped = await rewrapWithCachedPrf(cek)
    expect(rewrapped?.credentialId).toBe(enrolled.credentialId)
  })
})

describe('local state', () => {
  it('clearLocalState removes the PRF cache and local credential id', async () => {
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({ prfEnabled: true, prfFirst, attachment: 'platform' }),
      ),
    })

    const { kit } = makeKit()
    await kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    expect(kit.getCachedPrfResult()).not.toBeNull()
    expect(kit.getLocalCredentialId()).not.toBeNull()

    kit.clearLocalState()
    expect(kit.getCachedPrfResult()).toBeNull()
    expect(kit.getLocalCredentialId()).toBeNull()
  })

  it('operates without persistence when storage is null', async () => {
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({ prfEnabled: true, prfFirst, attachment: 'platform' }),
      ),
    })

    const kit = createPasskeyKit({
      rpId: 'example.com',
      rpName: 'Example',
      storage: null,
    })
    const result = await kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    expect(result).not.toBeNull()
    expect(kit.getCachedPrfResult()).toBeNull()
    expect(kit.getLocalCredentialId()).toBeNull()
  })

  it('does not discard the ceremony result when a custom adapter throws', async () => {
    const prfFirst = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    installCredentialsMock({
      create: vi.fn(async () =>
        fakeCredential({ prfEnabled: true, prfFirst, attachment: 'platform' }),
      ),
    })

    const kit = createPasskeyKit({
      rpId: 'example.com',
      rpName: 'Example',
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage is broken')
        },
        removeItem: () => {},
      },
    })
    const result = await kit.createPasskey({ id: 'u1', name: 'u@example.com' })
    expect(result).not.toBeNull()
  })

  it('authenticate([]) resolves null without opening a passkey prompt', async () => {
    const get = vi.fn()
    installCredentialsMock({ get })

    const { kit } = makeKit()
    await expect(kit.authenticate([])).resolves.toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})
