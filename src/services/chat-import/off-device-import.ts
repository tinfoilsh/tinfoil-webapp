import { requirePrimaryKeyB64 } from '@/services/cloud/cek-encoding'
import {
  importCreate,
  importStart,
  importUploadChunk,
  type ImportSource,
  type ImportStatusResponse,
} from '@/services/sync-enclave/sync-api'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Off-device chat import: upload a raw ChatGPT/Claude/Tinfoil export to
 * the sync enclave in fixed-size chunks, then hand the enclave the CEK
 * so it parses, seals, and stores every chat + attachment without the
 * plaintext ever touching application servers. The enclave emails the
 * user when the detached job finishes; the browser only needs to stay
 * open through the upload and the kickoff.
 */

// Mirrors the enclave's MaxImportChunkBytes; both sides must agree on
// the fixed chunk size so chunk offsets line up during reassembly.
export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024
export const IMPORT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export interface OffDeviceImportResult {
  jobId: string
  status: ImportStatusResponse
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

async function hashFileByChunk(file: File): Promise<{
  archiveSha256: string
  chunkSha256s: string[]
}> {
  const totalChunks = Math.ceil(file.size / IMPORT_CHUNK_BYTES)
  const archiveHash = sha256.create()
  const chunkSha256s: string[] = []

  for (let index = 0; index < totalChunks; index++) {
    const chunk = await readChunk(file, index)
    archiveHash.update(chunk)
    chunkSha256s.push(bytesToHex(sha256(chunk)))
  }

  return {
    archiveSha256: bytesToHex(archiveHash.digest()),
    chunkSha256s,
  }
}

export async function runOffDeviceImport(
  source: ImportSource,
  file: File,
): Promise<OffDeviceImportResult> {
  if (file.size === 0) {
    throw new Error('The export file is empty')
  }
  if (file.size > IMPORT_MAX_ARCHIVE_BYTES) {
    throw new Error('The export file is too large')
  }

  const totalChunks = Math.ceil(file.size / IMPORT_CHUNK_BYTES)
  const { archiveSha256, chunkSha256s } = await hashFileByChunk(file)

  const { job_id, upload_id } = await importCreate({
    source,
    totalBytes: file.size,
    totalChunks,
    archiveSha256,
  })

  for (let index = 0; index < totalChunks; index++) {
    const chunk = await readChunk(file, index)
    await importUploadChunk({
      uploadId: upload_id,
      chunkIndex: index,
      chunkSha256: chunkSha256s[index],
      data: chunk,
    })
  }

  const status = await importStart({
    jobId: job_id,
    keyB64: requirePrimaryKeyB64(),
  })

  return { jobId: job_id, status }
}
