import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockValidateCurrentPrimaryKey = vi.fn()
const mockKeyCurrent = vi.fn()
const mockRegisterKey = vi.fn()

vi.mock('@/services/cloud/cloud-key-preflight', () => ({
  CloudKeySetupError: class extends Error {
    remoteState: string
    constructor(message: string, remoteState: string) {
      super(message)
      this.name = 'CloudKeySetupError'
      this.remoteState = remoteState
    }
  },
  validateCurrentPrimaryKey: (...args: unknown[]) =>
    mockValidateCurrentPrimaryKey(...args),
}))

const TEST_KEY_B64 = vi.hoisted(() => {
  let bin = ''
  for (let i = 0; i < 32; i++) bin += String.fromCharCode(i + 1)
  return btoa(bin)
})

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => TEST_KEY_B64,
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    newIdempotencyKey: () => 'idem-test',
  }
})

import {
  AUTH_ACTIVE_USER_ID,
  SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX,
} from '@/constants/storage-keys'
import {
  authorizeCurrentPrimaryKey,
  canWriteToCloud,
  clearCloudKeyAuthorization,
  getCurrentCloudKeyAuthorizationMode,
  registerStartFreshKeyIfNeeded,
} from '@/services/cloud/cloud-key-authorization'
import { CloudKeySetupError } from '@/services/cloud/cloud-key-preflight'
import { deriveKeyIdHex } from '@/services/sync-enclave/key-bundle'
import { base64ToBytes } from '@/services/sync-enclave/sync-api'

const USER_ID = 'user-abc'

describe('cloud-key-authorization', () => {
  beforeEach(() => {
    localStorage.clear()
    mockValidateCurrentPrimaryKey.mockReset()
    mockKeyCurrent.mockReset()
    mockRegisterKey.mockReset()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, USER_ID)
  })

  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  describe('canWriteToCloud', () => {
    it('returns true when the enclave agrees the local CEK can write', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: true,
        probe: 'none',
      })
      expect(await canWriteToCloud()).toBe(true)
    })

    it('returns false when the enclave reports a KeyID mismatch', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: false,
        probe: 'none',
        message: "doesn't match",
      })
      expect(await canWriteToCloud()).toBe(false)
    })

    it('registers the key before allowing writes to an empty remote', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'empty',
        canWrite: true,
        probe: 'none',
      })
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'new-key-id' })

      expect(await canWriteToCloud()).toBe(true)

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      const arg = mockRegisterKey.mock.calls[0][0]
      expect(arg.createdVia).toBe('manual')
      expect(arg.ifMatch).toBe('*')
      expect(arg.keyB64).toBe(TEST_KEY_B64)
    })

    it('defers writes when empty-remote registration fails', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'empty',
        canWrite: true,
        probe: 'none',
      })
      mockRegisterKey.mockRejectedValue(new Error('conflict'))

      expect(await canWriteToCloud()).toBe(false)
    })
  })

  describe('getCurrentCloudKeyAuthorizationMode', () => {
    it('returns null when the enclave disagrees, even if localStorage hints validated', () => {
      // Pre-seed a legitimate-looking record from a previous session.
      localStorage.setItem(
        `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
        JSON.stringify({ mode: 'validated' }),
      )
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: false,
        probe: 'none',
      })
      return getCurrentCloudKeyAuthorizationMode().then((mode) => {
        expect(mode).toBeNull()
      })
    })

    it('returns the persisted mode hint when the enclave agrees', async () => {
      localStorage.setItem(
        `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
        JSON.stringify({ mode: 'explicit_start_fresh' }),
      )
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: true,
        probe: 'none',
      })
      expect(await getCurrentCloudKeyAuthorizationMode()).toBe(
        'explicit_start_fresh',
      )
    })

    it('defaults to validated when no hint is stored but enclave agrees', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'empty',
        canWrite: true,
        probe: 'none',
      })
      expect(await getCurrentCloudKeyAuthorizationMode()).toBe('validated')
    })
  })

  describe('authorizeCurrentPrimaryKey', () => {
    it('persists the mode hint when the enclave agrees', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: true,
        probe: 'none',
      })
      const ok = await authorizeCurrentPrimaryKey('explicit_start_fresh')
      expect(ok).toBe(true)
      const raw = localStorage.getItem(
        `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
      )
      expect(raw).toBeTruthy()
      expect(JSON.parse(raw!).mode).toBe('explicit_start_fresh')
    })

    it('refuses to persist the hint when the enclave disagrees', async () => {
      mockValidateCurrentPrimaryKey.mockResolvedValue({
        remoteState: 'exists',
        canWrite: false,
        probe: 'none',
      })
      const ok = await authorizeCurrentPrimaryKey('validated')
      expect(ok).toBe(false)
      expect(
        localStorage.getItem(
          `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
        ),
      ).toBeNull()
    })
  })

  describe('registerStartFreshKeyIfNeeded', () => {
    it('does not register when the registered key is already this CEK', async () => {
      const localKid = await deriveKeyIdHex(base64ToBytes(TEST_KEY_B64))
      mockKeyCurrent.mockResolvedValue({
        key_id: localKid,
        etag: 'etag-7',
        bundles: {},
      })
      await registerStartFreshKeyIfNeeded()
      expect(mockRegisterKey).not.toHaveBeenCalled()
    })

    it('registers with created_via=start_fresh when data exists under another key', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'old-key-id',
        etag: 'etag-7',
        bundles: {},
      })
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'new-key-id' })

      await registerStartFreshKeyIfNeeded()

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      const arg = mockRegisterKey.mock.calls[0][0]
      expect(arg.createdVia).toBe('start_fresh')
      expect(arg.ifMatch).toBe('etag-7')
      expect(arg.keyB64).toBe(TEST_KEY_B64)
    })

    it('registers a brand-new key when the remote has no key yet', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: null,
        etag: '',
        bundles: {},
        has_data: false,
      })
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'new-key-id' })

      await registerStartFreshKeyIfNeeded()

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      const arg = mockRegisterKey.mock.calls[0][0]
      expect(arg.createdVia).toBe('start_fresh')
      expect(arg.ifMatch).toBe('*')
    })

    it('falls back to the AnyKey sentinel when the enclave reports no etag', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: 'old-key-id', bundles: {} })
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'new-key-id' })

      await registerStartFreshKeyIfNeeded()

      expect(mockRegisterKey.mock.calls[0][0].ifMatch).toBe('*')
    })

    it('throws without wiping when the remote state cannot be verified', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('network'))

      await expect(registerStartFreshKeyIfNeeded()).rejects.toBeInstanceOf(
        CloudKeySetupError,
      )
      expect(mockRegisterKey).not.toHaveBeenCalled()
    })
  })

  it('clearCloudKeyAuthorization removes the hint', () => {
    localStorage.setItem(
      `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
      JSON.stringify({ mode: 'validated' }),
    )
    clearCloudKeyAuthorization()
    expect(
      localStorage.getItem(
        `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${USER_ID}`,
      ),
    ).toBeNull()
  })
})
