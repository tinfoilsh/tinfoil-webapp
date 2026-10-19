/**
 * Per-device bundle classification (`getPasskeyDeviceState`).
 *
 * The enclave already supports many bundles per key (one per
 * WebAuthn credential id). The client UX is only honest about that
 * when it asks "is *this* device's credential among the bundles?"
 * rather than "are there any bundles at all?". This file pins down
 * the three possible outcomes against a mocked `keyCurrent` so a
 * regression silently flipping the global/per-device check would
 * break the build.
 */

import { getPasskeyDeviceState } from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: vi.fn().mockReturnValue('key_test'),
    getKeyBytesOrThrow: () => new Uint8Array(32),
  },
}))

vi.mock('@/services/passkey/legacy-passkey-credentials', () => ({
  fetchLegacyPasskeyCredentials: vi.fn().mockResolvedValue([]),
}))

const mockKeyCurrent = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
  }
})

const KEY_ID = 'feedface'.repeat(8).slice(0, 64)
const LOCAL_CRED = 'this-device-cred'
const OTHER_CRED = 'mac-cred'

function bundle(credentialId: string) {
  return {
    credential_id: credentialId,
    kek_iv: '0'.repeat(24),
    encrypted_keys: '0'.repeat(96),
    bundle_version: 1,
    updated_at: new Date().toISOString(),
  }
}

describe('getPasskeyDeviceState', () => {
  beforeEach(() => {
    mockKeyCurrent.mockReset()
  })

  it('returns "this-device" when the local credential id is among the bundles', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: KEY_ID,
      etag: '1',
      bundles: {
        [LOCAL_CRED]: bundle(LOCAL_CRED),
        [OTHER_CRED]: bundle(OTHER_CRED),
      },
    })

    const state = await getPasskeyDeviceState(LOCAL_CRED)
    expect(state).toBe('this-device')
  })

  it('returns "other-device-only" when bundles exist but none match the local credential id', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: KEY_ID,
      etag: '1',
      bundles: { [OTHER_CRED]: bundle(OTHER_CRED) },
    })

    const state = await getPasskeyDeviceState(LOCAL_CRED)
    expect(state).toBe('other-device-only')
  })

  it('returns "other-device-only" when the local credential id is unknown but bundles exist', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: KEY_ID,
      etag: '1',
      bundles: { [OTHER_CRED]: bundle(OTHER_CRED) },
    })

    const state = await getPasskeyDeviceState(null)
    expect(state).toBe('other-device-only')
  })

  it('returns "empty" when there is a registered key but no bundles', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: KEY_ID,
      etag: '1',
      bundles: {},
    })

    const state = await getPasskeyDeviceState(LOCAL_CRED)
    expect(state).toBe('empty')
  })

  it('returns "unknown" when the enclave probe throws', async () => {
    mockKeyCurrent.mockRejectedValue(new Error('boom'))
    const state = await getPasskeyDeviceState(LOCAL_CRED)
    expect(state).toBe('unknown')
  })
})
