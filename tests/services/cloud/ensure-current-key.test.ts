import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRegisterKey = vi.fn()
const mockGetCachedPrf = vi.fn<() => unknown>()
const mockEmit = vi.fn()

const TEST_KEY_B64 = vi.hoisted(() => {
  let bin = ''
  for (let i = 0; i < 32; i++) bin += String.fromCharCode(i + 1)
  return btoa(bin)
})

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => TEST_KEY_B64,
  requirePrimaryKeyBytes: () => new Uint8Array(32),
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    newIdempotencyKey: () => 'idem-test',
  }
})

vi.mock('@/services/passkey/passkey-service', () => ({
  getCachedPrfResult: () => mockGetCachedPrf(),
  deriveKeyEncryptionKey: vi.fn(),
}))

vi.mock('@/services/passkey/passkey-key-storage', () => ({
  loadPasskeyCredentials: vi.fn(async () => []),
}))

vi.mock('@/services/sync-enclave/key-bundle', () => ({
  wrapCekForCredential: vi.fn(),
}))

vi.mock('@/services/sync-enclave/passkey-events', () => ({
  passkeyEvents: { emit: (...args: unknown[]) => mockEmit(...args) },
}))

import { adoptLocalKeyForMigration } from '@/services/cloud/ensure-current-key'

describe('ensure-current-key adoptLocalKeyForMigration', () => {
  beforeEach(() => {
    mockRegisterKey.mockReset()
    mockGetCachedPrf.mockReset()
    mockGetCachedPrf.mockReturnValue(null)
    mockEmit.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers the local CEK bundleless with created_via=recovery and if_match=*', async () => {
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'kid' })

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

  it('collapses concurrent adoptions for the same key into one registration', async () => {
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'kid' })

    const [ra, rb] = await Promise.all([
      adoptLocalKeyForMigration(),
      adoptLocalKeyForMigration(),
    ])

    expect(ra).toBe(true)
    expect(rb).toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledTimes(1)
  })
})
