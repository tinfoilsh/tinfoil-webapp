import {
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { harnessAPI } from '@/services/harness/runtime'
import {
  authorizeCurrentPrimaryKeyOrThrow,
  registerStartFreshKeyIfNeeded,
} from '@/services/keys/cloud-key-authorization'
import { CloudKeySetupError } from '@/services/keys/cloud-key-preflight'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  current: vi.fn(),
  register: vi.fn(),
}))
vi.mock('@/services/keys/cloud-key-preflight', async (importOriginal) => ({
  ...(await importOriginal()),
  validateCurrentPrimaryKey: mocks.validate,
}))
vi.mock('@/services/keys/cek-encoding', () => ({
  requirePrimaryKeyB64: () => 'active-key',
}))
vi.mock('@/services/harness/keys', async (importOriginal) => ({
  ...(await importOriginal()),
  keyCurrent: mocks.current,
  registerKey: mocks.register,
  newIdempotencyKey: () => 'nonce',
}))
beforeEach(() => {
  mocks.validate.mockReset()
  mocks.current.mockReset()
  mocks.register.mockReset()
})
it('refuses a mismatched key before registration', async () => {
  mocks.validate.mockResolvedValue({
    canWrite: false,
    remoteState: 'exists',
    message: 'wrong key',
  })
  await expect(authorizeCurrentPrimaryKeyOrThrow()).rejects.toThrow('wrong key')
  expect(mocks.register).not.toHaveBeenCalled()
})
it('registers a new account key through the harness', async () => {
  mocks.validate.mockResolvedValue({ canWrite: true, remoteState: 'empty' })
  mocks.current.mockResolvedValue({ key_id: null, has_data: false })
  await authorizeCurrentPrimaryKeyOrThrow()
  expect(mocks.register).toHaveBeenCalledWith({
    keyB64: 'active-key',
    ifMatch: '*',
    createdVia: 'manual',
    idempotencyKey: 'nonce',
  })
})
it('moves existing encrypted data to the active key through the harness', async () => {
  const stored = new Uint8Array(32).fill(1)
  const previous = new Uint8Array(32).fill(2)
  localStorage.setItem(
    USER_ENCRYPTION_KEY,
    encryptionService.encodeKeyFromBytes(stored),
  )
  localStorage.setItem(
    USER_ENCRYPTION_KEY_HISTORY,
    JSON.stringify([encryptionService.encodeKeyFromBytes(previous)]),
  )
  mocks.validate.mockResolvedValue({ canWrite: true, remoteState: 'exists' })
  mocks.current.mockResolvedValue({ key_id: null, has_data: true })

  await authorizeCurrentPrimaryKeyOrThrow()

  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  expect(harnessAPI().client.post).toHaveBeenCalledExactlyOnceWith(
    '/v1/keys/migrate-all',
    {
      keys: [
        { key: 'active-key' },
        { key: base64(stored) },
        { key: base64(previous) },
      ],
      target: { key: 'active-key' },
    },
    expect.any(AbortSignal),
  )
  expect(mocks.register).not.toHaveBeenCalled()
})
it('uses the current etag for an explicitly requested fresh start', async () => {
  mocks.current.mockResolvedValue({ key_id: 'old', etag: 'revision' })
  mocks.validate.mockResolvedValue({ canWrite: false, remoteState: 'exists' })
  await registerStartFreshKeyIfNeeded()
  expect(mocks.register).toHaveBeenCalledWith({
    keyB64: 'active-key',
    ifMatch: 'revision',
    createdVia: 'start_fresh',
    idempotencyKey: 'nonce',
  })
})
it('does not re-register a fresh start when this key is already registered', async () => {
  mocks.current.mockResolvedValue({ key_id: 'active-kid', etag: 'revision' })
  mocks.validate.mockResolvedValue({ canWrite: true, remoteState: 'exists' })
  await registerStartFreshKeyIfNeeded()
  expect(mocks.register).not.toHaveBeenCalled()
})
it('falls back to the any-key sentinel when the account has no key yet', async () => {
  mocks.current.mockResolvedValue({ key_id: null, etag: '', has_data: false })
  mocks.validate.mockResolvedValue({ canWrite: true, remoteState: 'empty' })
  await registerStartFreshKeyIfNeeded()
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
    keyB64: 'active-key',
    ifMatch: '*',
    createdVia: 'start_fresh',
    idempotencyKey: 'nonce',
  })
})
it('refuses a fresh start when the remote key state cannot be verified', async () => {
  mocks.current.mockResolvedValue({ key_id: 'old', etag: 'revision' })
  mocks.validate.mockResolvedValue({ canWrite: false, remoteState: 'unknown' })
  await expect(registerStartFreshKeyIfNeeded()).rejects.toBeInstanceOf(
    CloudKeySetupError,
  )
  expect(mocks.register).not.toHaveBeenCalled()
})
