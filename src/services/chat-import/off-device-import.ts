import { requirePrimaryKeyB64 } from '@/services/cloud/cek-encoding'
import {
  importCreate,
  importStart,
  importUploadChunk,
  type ImportSource,
  type ImportStatusResponse,
} from '@/services/sync-enclave/sync-api'

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

export interface OffDeviceImportResult {
  jobId: string
  status: ImportStatusResponse
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength)
  view.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view))
  let out = ''
  for (let i = 0; i < digest.length; i++) {
    out += digest[i].toString(16).padStart(2, '0')
  }
  return out
}

export async function runOffDeviceImport(
  source: ImportSource,
  file: File,
): Promise<OffDeviceImportResult> {
  const archive = new Uint8Array(await file.arrayBuffer())
  if (archive.length === 0) {
    throw new Error('The export file is empty')
  }

  const totalChunks = Math.ceil(archive.length / IMPORT_CHUNK_BYTES)
  const archiveSha256 = await sha256Hex(archive)

  const { job_id, upload_id } = await importCreate({
    source,
    totalBytes: archive.length,
    totalChunks,
    archiveSha256,
  })

  for (let index = 0; index < totalChunks; index++) {
    const start = index * IMPORT_CHUNK_BYTES
    const end = Math.min(start + IMPORT_CHUNK_BYTES, archive.length)
    const chunk = archive.subarray(start, end)
    await importUploadChunk({
      uploadId: upload_id,
      chunkIndex: index,
      chunkSha256: await sha256Hex(chunk),
      data: chunk,
    })
  }

  const status = await importStart({
    jobId: job_id,
    keyB64: requirePrimaryKeyB64(),
  })

  return { jobId: job_id, status }
}
