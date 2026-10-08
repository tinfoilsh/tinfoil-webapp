import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const importCreate = vi.fn()
const importUploadChunk = vi.fn()
const importStart = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', () => ({
  importCreate: (...args: unknown[]) => importCreate(...args),
  importUploadChunk: (...args: unknown[]) => importUploadChunk(...args),
  importStart: (...args: unknown[]) => importStart(...args),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => 'cek-base64',
}))

import {
  IMPORT_CHUNK_BYTES,
  runOffDeviceImport,
} from '@/services/chat-import/off-device-import'

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
