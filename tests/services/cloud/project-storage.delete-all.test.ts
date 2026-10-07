import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { createActiveAccountGuard } from '@/services/cloud/account-operation'
import { ProjectStorageService } from '@/services/cloud/project-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  canWriteToCloud: vi.fn(),
  deleteAllProjects: vi.fn(),
  newIdempotencyKey: vi.fn(),
  requirePrimaryKeyB64: vi.fn(),
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {},
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: mocks.canWriteToCloud,
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  pullKey: vi.fn(),
  requirePrimaryKeyB64: mocks.requirePrimaryKeyB64,
}))

vi.mock('@/services/sync-enclave/sync-api', () => ({
  deleteAllProjects: mocks.deleteAllProjects,
  deleteRow: vi.fn(),
  listStatus: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  newIdempotencyKey: mocks.newIdempotencyKey,
  pullItemPlaintext: vi.fn(),
}))

describe('ProjectStorageService.deleteAllProjects', () => {
  let guard: ReturnType<typeof createActiveAccountGuard>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canWriteToCloud.mockResolvedValue(true)
    mocks.requirePrimaryKeyB64.mockReturnValue('current-cek')
    mocks.newIdempotencyKey.mockReturnValue('delete-projects-idempotency')
    mocks.deleteAllProjects.mockResolvedValue({ ok: true, deleted: 4 })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'project-user')
    guard = createActiveAccountGuard()
    vi.spyOn(guard, 'assertCurrent')
  })
  afterEach(() => {
    guard.dispose()
    vi.restoreAllMocks()
  })

  it('deletes all projects in one atomic enclave request', async () => {
    const storage = new ProjectStorageService()

    await expect(storage.deleteAllProjects(guard)).resolves.toBe(4)
    expect(mocks.deleteAllProjects).toHaveBeenCalledOnce()
    expect(mocks.deleteAllProjects).toHaveBeenCalledWith({
      keyB64: 'current-cek',
      idempotencyKey: 'delete-projects-idempotency',
    })
    expect(mocks.requirePrimaryKeyB64).toHaveBeenCalledOnce()
    expect(mocks.newIdempotencyKey).toHaveBeenCalledOnce()
    expect(guard.assertCurrent).toHaveBeenCalledTimes(3)
  })

  it('does not request deletion when cloud writes are blocked', async () => {
    mocks.canWriteToCloud.mockResolvedValue(false)
    const storage = new ProjectStorageService()

    await expect(storage.deleteAllProjects(guard)).rejects.toThrow(
      'Cloud writes are blocked until your encryption key is verified',
    )
    expect(mocks.deleteAllProjects).not.toHaveBeenCalled()
  })

  it.each(['authorization', 'deletion'])(
    'rejects an account change during %s',
    async (stage) => {
      let finish!: () => void
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      const boundary =
        stage === 'authorization'
          ? mocks.canWriteToCloud
          : mocks.deleteAllProjects
      boundary.mockImplementationOnce(async () => {
        await gate
        return stage === 'authorization' ? true : { ok: true, deleted: 4 }
      })
      const deletion = new ProjectStorageService().deleteAllProjects(guard)
      const rejection = expect(deletion).rejects.toMatchObject({
        name: 'AbortError',
      })
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce())
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'other-user')
      finish()
      await rejection
      expect(mocks.deleteAllProjects).toHaveBeenCalledTimes(
        stage === 'authorization' ? 0 : 1,
      )
    },
  )

  it('propagates enclave failures without reporting a deletion', async () => {
    const failure = new Error('Enclave unavailable')
    mocks.deleteAllProjects.mockRejectedValue(failure)
    const storage = new ProjectStorageService()

    await expect(storage.deleteAllProjects(guard)).rejects.toBe(failure)
    expect(guard.assertCurrent).toHaveBeenCalledTimes(2)
  })
})
