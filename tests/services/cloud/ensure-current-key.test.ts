import {
  AUTH_ACTIVE_USER_ID,
  SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX,
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import { deriveTinfoilKeyIdHex } from '@/services/sync-enclave/tinfoil-key-id'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRegisterKey = vi.fn()
const mockKeyCurrent = vi.fn()
const mockAddBundle = vi.fn()
const mockEmit = vi.fn()
const mockLoadPasskeyCredentials = vi.fn()
const mockRewrapKeyFromCache = vi.fn()
const mockWrapTinfoilKeyBundle = vi.fn()
const mockBundleToEnclave = vi.fn()
const mockGetAlternativeKeyBytes = vi.fn()

const TEST_KEY_B64 = vi.hoisted(() => {
  let bin = ''
  for (let i = 0; i < 32; i++) bin += String.fromCharCode(i + 1)
  return btoa(bin)
})

const CHANGED_KEY_BYTES = new Uint8Array(32).fill(0x7a)
const CHANGED_KEY_B64 = btoa(String.fromCharCode(...CHANGED_KEY_BYTES))

interface RemoteKeyState {
  key_id: string | null
  etag?: string
  bundles: Record<
    string,
    { credential_id: string; kek_iv: string; encrypted_keys: string }
  >
}

let remoteKeyState: RemoteKeyState
let nextEtag: number

async function applySuccessfulRegister(request: {
  keyB64: string
  ifMatch: string
  initialBundle?: {
    credentialId: string
    kekIvHex: string
    encryptedKeysHex: string
  }
}) {
  if (request.ifMatch === '*' && remoteKeyState.key_id) {
    throw new Error('create conflict')
  }
  if (request.ifMatch !== '*' && request.ifMatch !== remoteKeyState.etag) {
    throw new Error('etag conflict')
  }
  const keyId = await deriveTinfoilKeyIdHex(
    Uint8Array.from(atob(request.keyB64), (character) =>
      character.charCodeAt(0),
    ),
  )
  remoteKeyState = {
    key_id: keyId,
    etag: String(nextEtag++),
    bundles: request.initialBundle
      ? {
          [request.initialBundle.credentialId]: {
            credential_id: request.initialBundle.credentialId,
            kek_iv: request.initialBundle.kekIvHex,
            encrypted_keys: request.initialBundle.encryptedKeysHex,
          },
        }
      : {},
  }
  return { ok: true, key_id: keyId }
}

interface AddBundleRequest {
  keyId: string
  keyB64: string
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
}

async function applySuccessfulAddBundle(request: AddBundleRequest) {
  const requestKeyId = await deriveTinfoilKeyIdHex(
    Uint8Array.from(atob(request.keyB64), (character) =>
      character.charCodeAt(0),
    ),
  )
  if (
    request.keyId !== remoteKeyState.key_id ||
    requestKeyId !== remoteKeyState.key_id
  ) {
    throw new Error('bundle target does not match remote key')
  }
  remoteKeyState = {
    ...remoteKeyState,
    bundles: {
      ...remoteKeyState.bundles,
      [request.credentialId]: {
        credential_id: request.credentialId,
        kek_iv: request.kekIvHex,
        encrypted_keys: request.encryptedKeysHex,
      },
    },
  }
  return { ok: true }
}

function enableInitialBundle(): void {
  const primaryWrapped = { credentialId: 'AQID' }
  mockLoadPasskeyCredentials.mockResolvedValue([{ id: 'AQID' }])
  mockRewrapKeyFromCache.mockResolvedValue(primaryWrapped)
  mockWrapTinfoilKeyBundle.mockImplementation(
    async (
      primary: { credentialId: string },
      keyBundle: { alternatives: string[]; authorizationMode: string },
    ) => ({
      primary,
      alternatives: keyBundle.alternatives,
      authorizationMode: keyBundle.authorizationMode,
    }),
  )
  mockBundleToEnclave.mockImplementation((bundle) => ({
    credentialId: bundle.primary.credentialId,
    kekIvHex: '01'.repeat(12),
    encryptedKeysHex: Buffer.from(JSON.stringify(bundle)).toString('hex'),
  }))
}

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const mockRequirePrimaryKeyB64 = vi.fn<() => string>()

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => mockRequirePrimaryKeyB64(),
  requirePrimaryKeyBytes: () => new Uint8Array(32),
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    addBundle: (...args: unknown[]) => mockAddBundle(...args),
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    newIdempotencyKey: () => 'idem-test',
  }
})

vi.mock('@/services/passkey/kit', () => ({
  passkeyKeyManager: {
    rewrapKeyFromCache: (...args: unknown[]) => mockRewrapKeyFromCache(...args),
  },
}))

vi.mock('@/services/passkey/passkey-key-storage', () => ({
  loadPasskeyCredentials: (...args: unknown[]) =>
    mockLoadPasskeyCredentials(...args),
  wrapTinfoilKeyBundle: (...args: unknown[]) =>
    mockWrapTinfoilKeyBundle(...args),
  tinfoilWrappedKeyBundleToEnclave: (...args: unknown[]) =>
    mockBundleToEnclave(...args),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getAlternativeKeyBytes: (...args: unknown[]) =>
      mockGetAlternativeKeyBytes(...args),
  },
}))

vi.mock('@/services/sync-enclave/passkey-events', () => ({
  passkeyEvents: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

import {
  ADOPTION_INITIAL_BUNDLE_TIMEOUT_MS,
  adoptLocalKeyForMigration,
} from '@/services/cloud/ensure-current-key'

describe('ensure-current-key adoptLocalKeyForMigration', () => {
  beforeEach(() => {
    remoteKeyState = { key_id: null, bundles: {} }
    nextEtag = 1
    mockRegisterKey.mockReset().mockImplementation(applySuccessfulRegister)
    mockKeyCurrent.mockReset().mockImplementation(async () => remoteKeyState)
    mockAddBundle.mockReset().mockImplementation(applySuccessfulAddBundle)
    mockEmit.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockRequirePrimaryKeyB64.mockReturnValue(TEST_KEY_B64)
    mockLoadPasskeyCredentials.mockReset().mockResolvedValue([])
    mockRewrapKeyFromCache.mockReset().mockResolvedValue(null)
    mockWrapTinfoilKeyBundle.mockReset()
    mockBundleToEnclave.mockReset()
    mockGetAlternativeKeyBytes
      .mockReset()
      .mockReturnValue(
        Uint8Array.from(atob(TEST_KEY_B64), (character) =>
          character.charCodeAt(0),
        ),
      )
    localStorage.clear()
    localStorage.setItem(USER_ENCRYPTION_KEY, 'key_persisted')
    localStorage.setItem(USER_ENCRYPTION_KEY_HISTORY, JSON.stringify([]))
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    localStorage.setItem(
      `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
      JSON.stringify({ mode: 'validated' }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('registers the local CEK bundleless with created_via=recovery and if_match=*', async () => {
    const ok = await adoptLocalKeyForMigration()

    expect(ok).toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledTimes(1)
    const arg = mockRegisterKey.mock.calls[0][0]
    expect(arg.createdVia).toBe('recovery')
    expect(arg.ifMatch).toBe('*')
    expect(arg.keyB64).toBe(TEST_KEY_B64)
    expect(arg.initialBundle).toBeUndefined()
  })

  it('returns false when registration is rejected', async () => {
    mockRegisterKey.mockRejectedValue(new Error('conflict'))
    expect(await adoptLocalKeyForMigration()).toBe(false)
  })

  it('defers without registering when no committed key exists', async () => {
    localStorage.removeItem(USER_ENCRYPTION_KEY)
    expect(await adoptLocalKeyForMigration()).toBe(false)
    expect(mockRegisterKey).not.toHaveBeenCalled()
  })

  it('defers without registering when a staged key differs from the committed key', async () => {
    // Mid-ceremony: the active in-memory CEK is a newly staged key that
    // has not been committed yet. Registering the committed key while
    // the upload would encrypt under the staged one must be refused.
    mockRequirePrimaryKeyB64.mockReturnValue('c3RhZ2VkLWtleS1ub3QtY29tbWl0dGVk')
    expect(await adoptLocalKeyForMigration()).toBe(false)
    expect(mockRegisterKey).not.toHaveBeenCalled()
  })

  it('uses persisted history and authorization before service initialization', async () => {
    localStorage.setItem(
      USER_ENCRYPTION_KEY_HISTORY,
      JSON.stringify(['key_previous_a', 'key_previous_b']),
    )
    localStorage.setItem(
      `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
      JSON.stringify({ mode: 'explicit_start_fresh' }),
    )
    const primaryWrapped = { credentialId: 'AQID' }
    const wrappedBundle = { primary: primaryWrapped, alternatives: [] }
    const transport = {
      credentialId: 'AQID',
      kekIvHex: '01'.repeat(12),
      encryptedKeysHex: '02',
    }
    mockLoadPasskeyCredentials.mockResolvedValue([{ id: 'AQID' }])
    mockRewrapKeyFromCache.mockResolvedValue(primaryWrapped)
    mockWrapTinfoilKeyBundle.mockResolvedValue(wrappedBundle)
    mockBundleToEnclave.mockReturnValue(transport)

    await expect(adoptLocalKeyForMigration()).resolves.toBe(true)

    expect(mockWrapTinfoilKeyBundle).toHaveBeenCalledWith(primaryWrapped, {
      primary: 'key_persisted',
      alternatives: ['key_previous_a', 'key_previous_b'],
      authorizationMode: 'explicit_start_fresh',
    })
    expect(mockRegisterKey.mock.calls[0][0].initialBundle).toEqual(transport)
  })

  it.each([
    ['primary', () => localStorage.setItem(USER_ENCRYPTION_KEY, 'key_changed')],
    [
      'history',
      () =>
        localStorage.setItem(
          USER_ENCRYPTION_KEY_HISTORY,
          JSON.stringify(['key_changed_history']),
        ),
    ],
    [
      'authorization',
      () =>
        localStorage.setItem(
          `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
          JSON.stringify({ mode: 'explicit_start_fresh' }),
        ),
    ],
  ])(
    'aborts when persisted %s changes during bundle lookup',
    async (_, mutate) => {
      let resolveCredentials: (entries: unknown[]) => void = () => {}
      mockLoadPasskeyCredentials.mockReturnValue(
        new Promise((resolve) => {
          resolveCredentials = resolve
        }),
      )

      const adoption = adoptLocalKeyForMigration()
      mutate()
      resolveCredentials([])

      await expect(adoption).resolves.toBe(false)
      expect(mockRegisterKey).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['primary', () => localStorage.setItem(USER_ENCRYPTION_KEY, 'key_changed')],
    [
      'history',
      () =>
        localStorage.setItem(
          USER_ENCRYPTION_KEY_HISTORY,
          JSON.stringify(['key_changed_history']),
        ),
    ],
    [
      'authorization',
      () =>
        localStorage.setItem(
          `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
          JSON.stringify({ mode: 'explicit_start_fresh' }),
        ),
    ],
    ['account', () => localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')],
  ])(
    'does not release writes when persisted %s changes during registration',
    async (_, mutate) => {
      let releaseRegistration: () => void = () => {}
      const registrationGate = new Promise<void>((resolve) => {
        releaseRegistration = resolve
      })
      mockRegisterKey.mockImplementationOnce(async (request) => {
        await registrationGate
        return applySuccessfulRegister(request)
      })

      const adoption = adoptLocalKeyForMigration()
      await vi.waitFor(() => expect(mockRegisterKey).toHaveBeenCalledOnce())
      mutate()
      releaseRegistration()

      await expect(adoption).resolves.toBe(false)
      expect(mockRegisterKey).toHaveBeenCalledOnce()
      expect(mockEmit).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'history',
      () =>
        localStorage.setItem(
          USER_ENCRYPTION_KEY_HISTORY,
          JSON.stringify(['key_new_history']),
        ),
    ],
    [
      'authorization',
      () =>
        localStorage.setItem(
          `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
          JSON.stringify({ mode: 'explicit_start_fresh' }),
        ),
    ],
    ['account', () => localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')],
  ])('queues a new adoption when snapshot %s changes', async (_, mutate) => {
    let releaseFirstRegistration: () => void = () => {}
    const registrationGate = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve
    })
    mockRegisterKey.mockImplementationOnce(async (request) => {
      await registrationGate
      return applySuccessfulRegister(request)
    })

    const staleAdoption = adoptLocalKeyForMigration()
    await vi.waitFor(() => expect(mockRegisterKey).toHaveBeenCalledOnce())
    mutate()
    const currentAdoption = adoptLocalKeyForMigration()

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    releaseFirstRegistration()
    await expect(staleAdoption).resolves.toBe(false)
    await expect(currentAdoption).resolves.toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockKeyCurrent.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(mockEmit).toHaveBeenCalledOnce()
  })

  it('does not let a persisted Start Fresh hint replace the server key', async () => {
    let releaseFirstRegistration: () => void = () => {}
    const registrationGate = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve
    })
    mockRegisterKey.mockImplementationOnce(async (request) => {
      await registrationGate
      return applySuccessfulRegister(request)
    })

    const staleAdoption = adoptLocalKeyForMigration()
    await vi.waitFor(() => expect(mockRegisterKey).toHaveBeenCalledOnce())
    localStorage.setItem(USER_ENCRYPTION_KEY, 'key_changed')
    localStorage.setItem(
      `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
      JSON.stringify({ mode: 'explicit_start_fresh' }),
    )
    mockGetAlternativeKeyBytes.mockImplementation((key: string) =>
      key === 'key_changed'
        ? CHANGED_KEY_BYTES
        : Uint8Array.from(atob(TEST_KEY_B64), (character) =>
            character.charCodeAt(0),
          ),
    )
    mockRequirePrimaryKeyB64.mockReturnValue(CHANGED_KEY_B64)
    const currentAdoption = adoptLocalKeyForMigration()

    releaseFirstRegistration()
    await expect(staleAdoption).resolves.toBe(false)
    await expect(currentAdoption).resolves.toBe(false)

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockRegisterKey.mock.calls[0][0].ifMatch).toBe('*')
    expect(mockRegisterKey.mock.calls[0][0].createdVia).toBe('recovery')
    expect(remoteKeyState.key_id).not.toBe(
      await deriveTinfoilKeyIdHex(CHANGED_KEY_BYTES),
    )
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it.each([
    [
      'history',
      () =>
        localStorage.setItem(
          USER_ENCRYPTION_KEY_HISTORY,
          JSON.stringify(['key_latest_history']),
        ),
    ],
    [
      'authorization',
      () =>
        localStorage.setItem(
          `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}user-1`,
          JSON.stringify({ mode: 'explicit_start_fresh' }),
        ),
    ],
  ])('accepts changed %s after a delayed create', async (field, mutate) => {
    enableInitialBundle()
    let releaseFirstRegistration: () => void = () => {}
    const registrationGate = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve
    })
    mockRegisterKey.mockImplementationOnce(async (request) => {
      await registrationGate
      return applySuccessfulRegister(request)
    })

    const staleAdoption = adoptLocalKeyForMigration()
    await vi.waitFor(() => expect(mockRegisterKey).toHaveBeenCalledOnce())
    mutate()
    const currentAdoption = adoptLocalKeyForMigration()
    releaseFirstRegistration()

    await expect(staleAdoption).resolves.toBe(false)
    await expect(currentAdoption).resolves.toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockAddBundle).toHaveBeenCalledOnce()
    expect(
      JSON.parse(
        Buffer.from(
          remoteKeyState.bundles.AQID.encrypted_keys,
          'hex',
        ).toString(),
      ),
    ).toEqual({
      primary: { credentialId: 'AQID' },
      alternatives: field === 'history' ? ['key_latest_history'] : [],
      authorizationMode:
        field === 'authorization' ? 'explicit_start_fresh' : 'validated',
    })
    expect(mockEmit).toHaveBeenCalledOnce()
  })

  it('blocks success when state changes during bundle reconciliation', async () => {
    enableInitialBundle()
    remoteKeyState = {
      key_id: await deriveTinfoilKeyIdHex(
        Uint8Array.from(atob(TEST_KEY_B64), (character) =>
          character.charCodeAt(0),
        ),
      ),
      etag: '1',
      bundles: {
        AQID: {
          credential_id: 'AQID',
          kek_iv: 'stale',
          encrypted_keys: 'stale',
        },
      },
    }
    let releaseBundleUpdate: () => void = () => {}
    const bundleUpdateGate = new Promise<void>((resolve) => {
      releaseBundleUpdate = resolve
    })
    mockAddBundle.mockImplementationOnce(async (request: AddBundleRequest) => {
      await bundleUpdateGate
      return applySuccessfulAddBundle(request)
    })

    const adoption = adoptLocalKeyForMigration()
    await vi.waitFor(() => expect(mockAddBundle).toHaveBeenCalledOnce())
    localStorage.setItem(
      USER_ENCRYPTION_KEY_HISTORY,
      JSON.stringify(['key_changed_during_update']),
    )
    releaseBundleUpdate()

    await expect(adoption).resolves.toBe(false)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('rejects bundle writes targeting the wrong remote key', async () => {
    enableInitialBundle()
    remoteKeyState = {
      key_id: await deriveTinfoilKeyIdHex(CHANGED_KEY_BYTES),
      etag: '1',
      bundles: {},
    }

    await expect(adoptLocalKeyForMigration()).resolves.toBe(false)
    expect(mockAddBundle).not.toHaveBeenCalled()
    expect(mockRegisterKey).not.toHaveBeenCalled()
    expect(remoteKeyState.bundles).toEqual({})
  })

  it('reconciles a create conflict against the actual current key', async () => {
    mockRegisterKey.mockImplementationOnce(async (request) => {
      await applySuccessfulRegister(request)
      throw new Error('response reported conflict')
    })

    await expect(adoptLocalKeyForMigration()).resolves.toBe(true)

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockKeyCurrent.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockEmit).toHaveBeenCalledOnce()
  })

  it('blocks when a create conflict reveals a different validated key', async () => {
    mockRegisterKey.mockImplementationOnce(async () => {
      remoteKeyState = { key_id: 'different-key-id', etag: '7', bundles: {} }
      throw new Error('create conflict')
    })

    await expect(adoptLocalKeyForMigration()).resolves.toBe(false)

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(remoteKeyState.key_id).toBe('different-key-id')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('times out legacy discovery and allows the next adoption to progress', async () => {
    vi.useFakeTimers()
    let discoverySignal: AbortSignal | undefined
    mockLoadPasskeyCredentials.mockImplementationOnce(
      (options: { signal?: AbortSignal }) => {
        discoverySignal = options.signal
        return new Promise(() => {})
      },
    )

    const firstAdoption = adoptLocalKeyForMigration()
    await vi.advanceTimersByTimeAsync(ADOPTION_INITIAL_BUNDLE_TIMEOUT_MS)
    await expect(firstAdoption).resolves.toBe(true)
    expect(discoverySignal?.aborted).toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledOnce()

    localStorage.setItem(
      USER_ENCRYPTION_KEY_HISTORY,
      JSON.stringify(['key_after_timeout']),
    )
    mockLoadPasskeyCredentials.mockResolvedValue([])
    await expect(adoptLocalKeyForMigration()).resolves.toBe(true)
    expect(mockKeyCurrent.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('deduplicates concurrent adoptions for the exact snapshot', async () => {
    const [ra, rb] = await Promise.all([
      adoptLocalKeyForMigration(),
      adoptLocalKeyForMigration(),
    ])

    expect(ra).toBe(true)
    expect(rb).toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledTimes(1)
  })
})
