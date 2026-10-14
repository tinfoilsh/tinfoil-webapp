import { requirePrimaryKeyB64 } from '@/services/cloud/cek-encoding'
import {
  importCreate,
  importStart,
  importStatus,
  importUploadChunk,
  type ImportSource,
  type ImportStatusResponse,
} from '@/services/sync-enclave/sync-api'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Off-device chat import: upload a raw ChatGPT/Claude/Tinfoil export to
 * the sync enclave in fixed-size chunks, then hand the enclave the CEK
 * so it parses, seals, and stores every chat + attachment without the
 * plaintext ever touching application servers. The enclave emails the
 * user when the detached job finishes; the browser only needs to stay
 * open through the upload and the kickoff, or, for an export split
 * across files, until the last file's job has started.
 */

// Mirrors the enclave's MaxImportChunkBytes; both sides must agree on
// the fixed chunk size so chunk offsets line up during reassembly.
export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024
export const IMPORT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export interface OffDeviceImportResult {
  jobId: string
  status: ImportStatusResponse
}

export type OffDeviceImportPhase = 'hashing' | 'uploading' | 'starting'

export interface OffDeviceImportProgress {
  phase: OffDeviceImportPhase
  /** Bytes processed so far within the current phase. */
  processedBytes: number
  totalBytes: number
}

export interface OffDeviceImportOptions {
  signal?: AbortSignal
  onProgress?: (progress: OffDeviceImportProgress) => void
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

async function readChunk(file: File, index: number): Promise<Uint8Array> {
  const start = index * IMPORT_CHUNK_BYTES
  const end = Math.min(start + IMPORT_CHUNK_BYTES, file.size)
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

async function hashFileByChunk(
  file: File,
  options: OffDeviceImportOptions,
): Promise<{
  archiveSha256: string
  chunkSha256s: string[]
}> {
  const totalChunks = Math.ceil(file.size / IMPORT_CHUNK_BYTES)
  const archiveHash = sha256.create()
  const chunkSha256s: string[] = []

  options.onProgress?.({
    phase: 'hashing',
    processedBytes: 0,
    totalBytes: file.size,
  })
  for (let index = 0; index < totalChunks; index++) {
    options.signal?.throwIfAborted()
    const chunk = await readChunk(file, index)
    archiveHash.update(chunk)
    chunkSha256s.push(bytesToHex(sha256(chunk)))
    options.onProgress?.({
      phase: 'hashing',
      processedBytes: Math.min((index + 1) * IMPORT_CHUNK_BYTES, file.size),
      totalBytes: file.size,
    })
  }

  return {
    archiveSha256: bytesToHex(archiveHash.digest()),
    chunkSha256s,
  }
}

export async function runOffDeviceImport(
  source: ImportSource,
  file: File,
  options: OffDeviceImportOptions = {},
): Promise<OffDeviceImportResult> {
  if (file.size === 0) {
    throw new Error('The export file is empty')
  }
  if (file.size > IMPORT_MAX_ARCHIVE_BYTES) {
    throw new Error('The export file is too large')
  }

  const totalChunks = Math.ceil(file.size / IMPORT_CHUNK_BYTES)
  const { archiveSha256, chunkSha256s } = await hashFileByChunk(file, options)

  const { job_id, upload_id } = await importCreate(
    { source, totalBytes: file.size, totalChunks, archiveSha256 },
    options.signal,
  )

  options.onProgress?.({
    phase: 'uploading',
    processedBytes: 0,
    totalBytes: file.size,
  })
  for (let index = 0; index < totalChunks; index++) {
    options.signal?.throwIfAborted()
    const chunk = await readChunk(file, index)
    await importUploadChunk(
      {
        uploadId: upload_id,
        chunkIndex: index,
        chunkSha256: chunkSha256s[index],
        data: chunk,
      },
      options.signal,
    )
    options.onProgress?.({
      phase: 'uploading',
      processedBytes: Math.min((index + 1) * IMPORT_CHUNK_BYTES, file.size),
      totalBytes: file.size,
    })
  }

  options.signal?.throwIfAborted()
  options.onProgress?.({
    phase: 'starting',
    processedBytes: file.size,
    totalBytes: file.size,
  })
  const status = await importStart(
    { jobId: job_id, keyB64: requirePrimaryKeyB64() },
    options.signal,
  )

  return { jobId: job_id, status }
}

const IMPORT_STATUS_POLL_MS = 2000
// A poll can fail transiently while a long job keeps running; only give
// up on the sequence once the enclave stays unreachable.
const MAX_CONSECUTIVE_STATUS_FAILURES = 5

/**
 * A job we were polling has vanished from the enclave, which only
 * happens when the enclave restarted or reaped it. Its outcome is
 * unknown to the browser.
 */
export function isImportJobGone(cause: unknown): boolean {
  return cause instanceof SyncEnclaveError && cause.status === 404
}

function isImportJobFinished(status: ImportStatusResponse): boolean {
  return status.status === 'completed' || status.status === 'failed'
}

export interface OffDeviceImportSequenceOptions {
  onUploadProgress?: (
    fileIndex: number,
    progress: OffDeviceImportProgress,
  ) => void
  /** Called with each status polled while an earlier file is processed. */
  onProcessing?: (fileIndex: number, status: ImportStatusResponse) => void
  wait?: (ms: number) => Promise<void>
}

export interface OffDeviceImportSequenceResult {
  /**
   * The last job's status: the one that failed or was interrupted, or
   * the final file's kickoff snapshot when every earlier file completed.
   */
  status: ImportStatusResponse
  /** Index into the files of the job `status` describes. */
  fileIndex: number
  /** Chats imported by the files that completed before `fileIndex`. */
  importedBefore: number
  /** The enclave lost the job at `fileIndex` while it was processing. */
  interrupted: boolean
}

/**
 * Imports a split export as one job per file. The enclave runs one
 * import per user at a time and rejects a second create while a job is
 * running, so each file except the last is processed to completion
 * before the next is uploaded. The sequence stops at the first file that
 * fails so a later success never hides it. The last file's job is left
 * running; the enclave emails the user when it finishes.
 */
export async function runOffDeviceImports(
  source: ImportSource,
  files: readonly File[],
  options: OffDeviceImportSequenceOptions = {},
): Promise<OffDeviceImportSequenceResult> {
  if (files.length === 0) {
    throw new Error('No export files were selected')
  }
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let importedBefore = 0
  for (let fileIndex = 0; ; fileIndex++) {
    const started = await runOffDeviceImport(source, files[fileIndex], {
      onProgress: (progress) => options.onUploadProgress?.(fileIndex, progress),
    })
    let status = started.status
    const isLast = fileIndex === files.length - 1
    if (!isLast && !isImportJobFinished(status)) {
      options.onProcessing?.(fileIndex, status)
    }
    let consecutiveFailures = 0
    while (!isLast && !isImportJobFinished(status)) {
      await wait(IMPORT_STATUS_POLL_MS)
      try {
        status = await importStatus(started.jobId)
        consecutiveFailures = 0
      } catch (cause) {
        if (isImportJobGone(cause)) {
          return { status, fileIndex, importedBefore, interrupted: true }
        }
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) throw cause
        continue
      }
      options.onProcessing?.(fileIndex, status)
    }
    if (isLast || status.status === 'failed') {
      return { status, fileIndex, importedBefore, interrupted: false }
    }
    importedBefore += status.imported
  }
}
