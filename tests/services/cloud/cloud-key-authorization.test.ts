import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockValidateCurrentPrimaryKey = vi.fn()

vi.mock('@/services/cloud/cloud-key-preflight', () => ({
  validateCurrentPrimaryKey: (...args: unknown[]) =>
    mockValidateCurrentPrimaryKey(...args),
}))

import {
  AUTH_ACTIVE_USER_ID,
  SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX,
} from '@/constants/storage-keys'
import {
  authorizeCurrentPrimaryKey,
  canWriteToCloud,
  clearCloudKeyAuthorization,
  getCurrentCloudKeyAuthorizationMode,
} from '@/services/cloud/cloud-key-authorization'

const USER_ID = 'user-abc'

describe('cloud-key-authorization', () => {
  beforeEach(() => {
    localStorage.clear()
    mockValidateCurrentPrimaryKey.mockReset()
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
