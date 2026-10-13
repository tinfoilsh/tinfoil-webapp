import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { canWriteToCloud } from '@/services/cloud/cloud-key-authorization'
import { ProjectStorageService } from '@/services/cloud/project-storage'
import type { RetryScheduler } from '@/services/sync-enclave/retry-policy'
import {
  SyncEnclaveError,
  SyncNetworkError,
  SyncRequestTimeoutError,
} from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enclavePush: vi.fn(),
  newIdempotencyKey: vi.fn(),
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: { getToken: vi.fn() },
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: vi.fn(),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  pullKey: () => [{ key: 'primary-key' }],
  requirePrimaryKeyB64: () => 'primary-key',
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    push: mocks.enclavePush,
    newIdempotencyKey: mocks.newIdempotencyKey,
  }
})

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

// Records each backoff delay and resolves it immediately.
function immediateScheduler() {
  const delays: number[] = []
  const scheduler: RetryScheduler = {
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
  return { scheduler, delays }
}

// Holds the first backoff until the test releases it, so the test can act
// while the upload is waiting to retry.
function heldScheduler() {
  const delays: number[] = []
  let notifySleeping!: () => void
  let release!: () => void
  const sleeping = new Promise<void>((resolve) => {
    notifySleeping = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const scheduler: RetryScheduler = {
    random: () => 0.5,
    sleep: (ms) => {
      delays.push(ms)
      notifySleeping()
      return held
    },
  }
  return { scheduler, delays, sleeping, release }
}

// A fresh id on every call, so reusing the first id is observable.
function stubDocumentIds(storage: ProjectStorageService) {
  return vi
    .spyOn(storage, 'generateDocumentId')
    .mockResolvedValueOnce({
      documentId: 'doc-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reverseTimestamp: 1,
    })
    .mockResolvedValueOnce({
      documentId: 'doc-2',
      timestamp: '2026-01-01T00:00:01.000Z',
      reverseTimestamp: 2,
    })
}

function uploadStatement(storage: ProjectStorageService) {
  return storage.uploadDocument(
    'project-1',
    'statement.pdf',
    'application/pdf',
    'Statement text',
    4096,
  )
}

function pushedRequests() {
  return mocks.enclavePush.mock.calls.map(([request]) => request)
}

describe('ProjectStorageService document upload retries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(canWriteToCloud).mockReset().mockResolvedValue(true)
    mocks.enclavePush.mockReset()
    let issuedKeys = 0
    mocks.newIdempotencyKey
      .mockReset()
      .mockImplementation(() => `idem-${++issuedKeys}`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries a timed-out save as the same document and payload', async () => {
    const { scheduler } = immediateScheduler()
    const storage = new ProjectStorageService(scheduler)
    const generateDocumentId = stubDocumentIds(storage)
    mocks.enclavePush
      .mockRejectedValueOnce(new SyncRequestTimeoutError())
      .mockResolvedValueOnce({ ok: true, etag: '3' })

    const document = await uploadStatement(storage)

    expect(generateDocumentId).toHaveBeenCalledTimes(1)
    const [first, second] = pushedRequests()
    expect(pushedRequests()).toHaveLength(2)
    expect(first).toMatchObject({
      scope: 'project_document',
      id: 'project-1/doc-1',
      keyB64: 'primary-key',
      ifMatch: null,
      idempotencyKey: 'idem-1',
    })
    expect(JSON.parse(new TextDecoder().decode(first.plaintext))).toEqual({
      content: 'Statement text',
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
    })
    expect(second).toEqual(first)
    expect(document).toMatchObject({
      id: 'doc-1',
      projectId: 'project-1',
      syncVersion: 3,
      content: 'Statement text',
    })
  })

  it('waits for the backoff before retrying', async () => {
    const held = heldScheduler()
    const storage = new ProjectStorageService(held.scheduler)
    stubDocumentIds(storage)
    mocks.enclavePush
      .mockRejectedValueOnce(new SyncNetworkError())
      .mockResolvedValueOnce({ ok: true, etag: '1' })

    const upload = uploadStatement(storage)
    await held.sleeping

    expect(held.delays).toEqual([500])
    expect(mocks.enclavePush).toHaveBeenCalledTimes(1)
    held.release()
    await expect(upload).resolves.toMatchObject({ id: 'doc-1' })
    expect(mocks.enclavePush).toHaveBeenCalledTimes(2)
  })

  it('gives up after three retries and reports the last failure', async () => {
    const { scheduler, delays } = immediateScheduler()
    const storage = new ProjectStorageService(scheduler)
    stubDocumentIds(storage)
    const failures = [1, 2, 3, 4].map(
      (attempt) => new SyncEnclaveError(`upstream ${attempt}`, 503, 'UPSTREAM'),
    )
    for (const failure of failures) {
      mocks.enclavePush.mockRejectedValueOnce(failure)
    }

    await expect(uploadStatement(storage)).rejects.toBe(failures[3])
    expect(delays).toEqual([500, 1000, 2000])
    expect(pushedRequests().map((request) => request.idempotencyKey)).toEqual([
      'idem-1',
      'idem-1',
      'idem-1',
      'idem-1',
    ])
  })

  it('does not retry a save the enclave rejects', async () => {
    const { scheduler, delays } = immediateScheduler()
    const storage = new ProjectStorageService(scheduler)
    stubDocumentIds(storage)
    const tooLarge = new SyncEnclaveError(
      'plaintext exceeds 33554432 bytes',
      413,
      'PAYLOAD_TOO_LARGE',
    )
    mocks.enclavePush.mockRejectedValueOnce(tooLarge)

    await expect(uploadStatement(storage)).rejects.toBe(tooLarge)
    expect(mocks.enclavePush).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('stops retrying when the account changes during the backoff', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
    const held = heldScheduler()
    const storage = new ProjectStorageService(held.scheduler)
    stubDocumentIds(storage)
    mocks.enclavePush
      .mockRejectedValueOnce(new SyncNetworkError())
      .mockResolvedValueOnce({ ok: true, etag: '1' })

    const upload = uploadStatement(storage)
    await held.sleeping
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-b')
    held.release()

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.enclavePush).toHaveBeenCalledTimes(1)
  })
})
