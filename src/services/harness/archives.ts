import { harnessAPI } from './runtime'
export type ImportFailureReason =
  'invalid_archive' | 'wrong_key' | 'internal_error' | string
export interface ImportStatusResponse {
  status: 'staging' | 'running' | 'completed' | 'partial' | 'failed'
  phase?: string
  imported: number
  failed: number
  total: number
  jobId?: string
  failure_reason?: ImportFailureReason
  failureReason?: ImportFailureReason
  errors?: string[]
  warnings?: string[]
  counts?: Record<
    string,
    { imported: number; skipped: number; failed: number; blocked: number }
  >
}
export function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function exportArchive(
  format: 'tinfoil-backup' | 'claude-projects',
  signal?: AbortSignal,
) {
  const blob = await harnessAPI().download('/v1/export', { format }, signal)
  signal?.throwIfAborted()
  saveDownload(
    blob,
    format === 'tinfoil-backup' ? 'tinfoil-backup.zip' : 'projects.json',
  )
}
export async function startImport(
  file: File,
  source: string,
  signal?: AbortSignal,
): Promise<ImportStatusResponse> {
  const api = harnessAPI()
  const { jobId } = await api.upload<{ jobId: string }>(
    '/v1/import',
    file,
    { source },
    signal,
  )
  const status = await api.post<ImportStatusResponse>(
    '/v1/import/status',
    { jobId },
    signal,
    false,
  )
  return { ...status, jobId }
}
export async function importStatus(jobId: string, signal?: AbortSignal) {
  const status = await harnessAPI().post<ImportStatusResponse>(
    '/v1/import/status',
    { jobId },
    signal,
    false,
  )
  return { ...status, jobId }
}
