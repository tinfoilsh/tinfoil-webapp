import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const importCreate = vi.fn()
const importUploadChunk = vi.fn()
const importStart = vi.fn()
const importStatus = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', () => ({
  importCreate: (...args: unknown[]) => importCreate(...args),
  importUploadChunk: (...args: unknown[]) => importUploadChunk(...args),
  importStart: (...args: unknown[]) => importStart(...args),
  importStatus: (...args: unknown[]) => importStatus(...args),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => 'cek-base64',
}))

import {
  IMPORT_CHUNK_BYTES,
  OffDeviceImportSequenceError,
  runOffDeviceImport,
  runOffDeviceImports,
} from '@/services/chat-import/off-device-import'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'

function fileOf(bytes: Uint8Array): File {
  return new File([new Uint8Array(bytes)], 'export.zip', {
    type: 'application/zip',
  })
}

describe('runOffDeviceImport', () => {
  beforeEach(() => {
    importCreate.mockReset()
    importUploadChunk.mockReset()
    importStart.mockReset()
    importCreate.mockResolvedValue({ job_id: 'job-1', upload_id: 'up-1' })
    importUploadChunk.mockResolvedValue({ ok: true })
    importStart.mockResolvedValue({
      status: 'running',
      imported: 0,
      failed: 0,
      total: 0,
      errors: [],
    })
  })

  it('rejects an empty file before any upload', async () => {
    await expect(
      runOffDeviceImport('chatgpt', fileOf(new Uint8Array())),
    ).rejects.toThrow()
    expect(importCreate).not.toHaveBeenCalled()
  })

  it('splits a large archive into fixed-size chunks and hands the CEK to start', async () => {
    const size = IMPORT_CHUNK_BYTES + 1234
    const archive = new Uint8Array(size)
    for (let i = 0; i < size; i++) archive[i] = i % 251
    const signal = new AbortController().signal

    const result = await runOffDeviceImport('claude', fileOf(archive), {
      signal,
    })

    expect(importCreate).toHaveBeenCalledTimes(1)
    const createArg = importCreate.mock.calls[0][0]
    expect(createArg).toEqual({
      source: 'claude',
      totalBytes: size,
      totalChunks: 2,
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
    })
    expect(importCreate.mock.calls[0][1]).toBe(signal)

    expect(importUploadChunk).toHaveBeenCalledTimes(2)
    for (const [index, expected] of [
      archive.subarray(0, IMPORT_CHUNK_BYTES),
      archive.subarray(IMPORT_CHUNK_BYTES),
    ].entries()) {
      const [request, uploadSignal] = importUploadChunk.mock.calls[index]
      const { data, ...metadata } = request
      expect(Buffer.compare(Buffer.from(data), Buffer.from(expected))).toBe(0)
      expect(metadata).toEqual({
        uploadId: 'up-1',
        chunkIndex: index,
        chunkSha256: createHash('sha256').update(expected).digest('hex'),
      })
      expect(uploadSignal).toBe(signal)
    }

    expect(importStart).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        keyB64: 'cek-base64',
      },
      signal,
    )
    expect(result.jobId).toBe('job-1')
  })

  it('reports byte progress through hashing, uploading, and kickoff', async () => {
    const size = IMPORT_CHUNK_BYTES + 1234
    const onProgress = vi.fn()

    await runOffDeviceImport('claude', fileOf(new Uint8Array(size)), {
      onProgress,
    })

    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      { phase: 'hashing', processedBytes: 0, totalBytes: size },
      {
        phase: 'hashing',
        processedBytes: IMPORT_CHUNK_BYTES,
        totalBytes: size,
      },
      { phase: 'hashing', processedBytes: size, totalBytes: size },
      { phase: 'uploading', processedBytes: 0, totalBytes: size },
      {
        phase: 'uploading',
        processedBytes: IMPORT_CHUNK_BYTES,
        totalBytes: size,
      },
      { phase: 'uploading', processedBytes: size, totalBytes: size },
      { phase: 'starting', processedBytes: size, totalBytes: size },
    ])
  })
})

describe('runOffDeviceImports', () => {
  // The enclave runs one import per user, so the order of creates and
  // status polls is the contract under test.
  let events: string[]
  let jobs: number
  const noWait = async () => {}

  function namedFile(name: string): File {
    return new File([new TextEncoder().encode(`[${name}]`)], name, {
      type: 'application/json',
    })
  }

  function job(status: string, imported = 0, extra = {}) {
    return {
      status,
      imported,
      failed: 0,
      total: imported,
      errors: [],
      ...extra,
    }
  }

  beforeEach(() => {
    events = []
    jobs = 0
    importCreate.mockReset()
    importUploadChunk.mockReset()
    importStart.mockReset()
    importStatus.mockReset()
    importCreate.mockImplementation(async () => {
      jobs++
      events.push(`create job-${jobs}`)
      return { job_id: `job-${jobs}`, upload_id: `up-${jobs}` }
    })
    importUploadChunk.mockResolvedValue({ ok: true })
    importStart.mockImplementation(async ({ jobId }: { jobId: string }) => {
      events.push(`start ${jobId}`)
      return job('running')
    })
  })

  function scriptStatuses(script: Record<string, Array<object | Error>>) {
    importStatus.mockImplementation(async (jobId: string) => {
      const next = script[jobId]?.shift()
      if (!next) throw new Error(`unexpected status poll for ${jobId}`)
      events.push(
        `status ${jobId} ${next instanceof Error ? 'error' : (next as { status: string }).status}`,
      )
      if (next instanceof Error) throw next
      return next
    })
  }

  it('finishes each file before uploading the next and leaves the last running', async () => {
    scriptStatuses({
      'job-1': [job('running', 1), job('completed', 4)],
      'job-2': [job('completed', 3)],
    })
    const onProcessing = vi.fn()

    const result = await runOffDeviceImports(
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
        namedFile('conversations-002.json'),
      ],
      { wait: noWait, onProcessing },
    )

    expect(events).toEqual([
      'create job-1',
      'start job-1',
      'status job-1 running',
      'status job-1 completed',
      'create job-2',
      'start job-2',
      'status job-2 completed',
      'create job-3',
      'start job-3',
    ])
    expect(result).toEqual({
      status: job('running'),
      fileIndex: 2,
      importedBefore: 7,
      interrupted: false,
    })
    expect(
      onProcessing.mock.calls.map(([index, s]) => [index, s.status]),
    ).toEqual([
      [0, 'running'],
      [0, 'running'],
      [0, 'completed'],
      [1, 'running'],
      [1, 'completed'],
    ])
  })

  it('stops at the first file that fails', async () => {
    const failed = job('failed', 0, {
      failure_reason: 'invalid_archive',
      failure_detail: 'unexpected_json',
    })
    scriptStatuses({ 'job-1': [failed] })

    const result = await runOffDeviceImports(
      'chatgpt',
      [namedFile('user.json'), namedFile('conversations-000.json')],
      { wait: noWait },
    )

    expect(events).toEqual([
      'create job-1',
      'start job-1',
      'status job-1 failed',
    ])
    expect(result).toEqual({
      status: failed,
      fileIndex: 0,
      importedBefore: 0,
      interrupted: false,
    })
  })

  it('reports a job the enclave lost as interrupted without starting the next', async () => {
    scriptStatuses({
      'job-1': [
        job('running', 2),
        new SyncEnclaveError('import job not found', 404, 'NOT_FOUND'),
      ],
    })

    const result = await runOffDeviceImports(
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    )

    expect(events).toEqual([
      'create job-1',
      'start job-1',
      'status job-1 running',
      'status job-1 error',
    ])
    expect(result).toEqual({
      status: job('running', 2),
      fileIndex: 0,
      importedBefore: 0,
      interrupted: true,
    })
  })

  it('keeps waiting through a transient status failure', async () => {
    scriptStatuses({
      'job-1': [new SyncEnclaveError('bad gateway', 502), job('completed', 5)],
    })

    const result = await runOffDeviceImports(
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    )

    expect(events).toEqual([
      'create job-1',
      'start job-1',
      'status job-1 error',
      'status job-1 completed',
      'create job-2',
      'start job-2',
    ])
    expect(result.importedBefore).toBe(5)
    expect(result.fileIndex).toBe(1)
  })

  it('gives up once the enclave stays unreachable instead of starting the next file', async () => {
    const unreachable = new SyncEnclaveError('bad gateway', 502)
    scriptStatuses({ 'job-1': Array.from({ length: 5 }, () => unreachable) })

    const error = await runOffDeviceImports(
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OffDeviceImportSequenceError)
    expect(error).toMatchObject({ fileIndex: 0, importedBefore: 0 })
    expect((error as Error).cause).toBe(unreachable)
    expect(importCreate).toHaveBeenCalledTimes(1)
  })

  it('keeps the chats earlier files imported when a later file cannot start', async () => {
    scriptStatuses({ 'job-1': [job('completed', 4)] })
    const busy = new SyncEnclaveError(
      'an import is already in progress',
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    importCreate
      .mockImplementationOnce(async () => {
        events.push('create job-1')
        return { job_id: 'job-1', upload_id: 'up-1' }
      })
      .mockRejectedValueOnce(busy)

    const error = await runOffDeviceImports(
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
        namedFile('conversations-002.json'),
      ],
      { wait: noWait },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OffDeviceImportSequenceError)
    expect(error).toMatchObject({
      message: 'an import is already in progress',
      fileIndex: 1,
      importedBefore: 4,
    })
    expect((error as Error).cause).toBe(busy)
  })
})
