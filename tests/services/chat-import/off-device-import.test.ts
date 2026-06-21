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
  return new File([bytes], 'export.zip', { type: 'application/zip' })
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

    const result = await runOffDeviceImport('claude', fileOf(archive))

    expect(importCreate).toHaveBeenCalledTimes(1)
    const createArg = importCreate.mock.calls[0][0]
    expect(createArg.source).toBe('claude')
    expect(createArg.totalBytes).toBe(size)
    expect(createArg.totalChunks).toBe(2)
    expect(createArg.archiveSha256).toMatch(/^[0-9a-f]{64}$/)

    expect(importUploadChunk).toHaveBeenCalledTimes(2)
    const first = importUploadChunk.mock.calls[0][0]
    const second = importUploadChunk.mock.calls[1][0]
    expect(first.uploadId).toBe('up-1')
    expect(first.chunkIndex).toBe(0)
    expect(first.data.byteLength).toBe(IMPORT_CHUNK_BYTES)
    expect(second.chunkIndex).toBe(1)
    expect(second.data.byteLength).toBe(1234)

    expect(importStart).toHaveBeenCalledWith({
      jobId: 'job-1',
      keyB64: 'cek-base64',
    })
    expect(result.jobId).toBe('job-1')
  })
})
