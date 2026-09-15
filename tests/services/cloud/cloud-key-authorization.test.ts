import {
  authorizeCurrentPrimaryKeyOrThrow,
  registerStartFreshKeyIfNeeded,
} from '@/services/keys/cloud-key-authorization'
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
