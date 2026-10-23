import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { encryptionService } from '@/services/encryption/encryption-service'
import { harnessAPI } from '@/services/harness/runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Recovery runs the real key authorization against the harness's reported
// key state. Only the harness's key routes and the passkey ceremony are fakes.
const mocks = vi.hoisted(() => ({
  keyCurrent: vi.fn(),
  registerKey: vi.fn(),
  loadRecoveryCandidates: vi.fn(),
  recoverPasskeyKeyBundle: vi.fn(),
}))
vi.mock('@/services/harness/keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/harness/keys')>()),
  keyCurrent: mocks.keyCurrent,
  registerKey: mocks.registerKey,
}))
vi.mock('@/services/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/passkey')>()),
  loadRecoveryCandidates: mocks.loadRecoveryCandidates,
  recoverPasskeyKeyBundle: mocks.recoverPasskeyKeyBundle,
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const bytes = (fill: number) => new Uint8Array(32).fill(fill)
const base64 = (fill: number) => Buffer.from(bytes(fill)).toString('base64')
const DEVICE_KEY = encryptionService.encodeKeyFromBytes(bytes(1))
const BACKUP_KEY = encryptionService.encodeKeyFromBytes(bytes(2))

beforeEach(async () => {
  mocks.keyCurrent.mockReset()
  mocks.registerKey.mockReset().mockResolvedValue({})
  mocks.loadRecoveryCandidates
    .mockReset()
    .mockResolvedValue([{ id: 'cred-1', source: 'enclave' }])
  mocks.recoverPasskeyKeyBundle.mockReset().mockResolvedValue({
    credentialId: 'cred-1',
    keyBundle: {
      primary: BACKUP_KEY,
      alternatives: [],
      authorizationMode: 'explicit_start_fresh',
    },
    syncVersion: 1,
    bundleVersion: 1,
    source: 'enclave',
  })
  await encryptionService.setKey(DEVICE_KEY)
})

afterEach(() => {
  encryptionService.clearKey()
})

async function recoverStartFreshBackup() {
  const { result } = renderHook(() =>
    usePasskeyBackup({
      encryptionKey: DEVICE_KEY,
      initialized: false,
      isSignedIn: true,
      user: { id: 'user_1' } as Parameters<typeof usePasskeyBackup>[0]['user'],
    }),
  )
  let recovered: string | null | undefined
  await act(async () => {
    recovered = await result.current.recoverWithPasskey()
  })
  return { result, recovered }
}

it('refuses a Start Fresh backup of another key without replacing the registered key', async () => {
  mocks.keyCurrent.mockResolvedValue({
    key_id: 'kid-of-the-current-key',
    etag: 'revision',
    has_data: true,
    bundles: {},
  })

  const { result, recovered } = await recoverStartFreshBackup()

  expect(recovered).toBeNull()
  expect(result.current.passkeyRecoveryFailure).toBe('stale_backup')
  expect(mocks.registerKey).not.toHaveBeenCalled()
  expect(encryptionService.getAllKeys()).toEqual({
    primary: DEVICE_KEY,
    alternatives: [],
  })
})

it('moves legacy data to a recovered Start Fresh key instead of dropping it', async () => {
  mocks.keyCurrent.mockResolvedValue({
    key_id: null,
    etag: '',
    has_data: true,
    bundles: {},
  })

  const { result, recovered } = await recoverStartFreshBackup()

  expect(recovered).toBe(BACKUP_KEY)
  expect(result.current.passkeyRecoveryFailure).toBeNull()
  expect(mocks.registerKey).not.toHaveBeenCalled()
  expect(harnessAPI().client.post).toHaveBeenCalledExactlyOnceWith(
    '/v1/keys/migrate-all',
    {
      keys: [{ key: base64(2) }, { key: base64(1) }],
      target: { key: base64(2) },
    },
    expect.any(AbortSignal),
  )
})
