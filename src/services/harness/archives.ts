import { harnessAPI } from './runtime'
import { HarnessError } from './sse'
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
  failure_detail?: string
  failureDetail?: string
  errors?: string[]
  warnings?: string[]
  counts?: Record<
    string,
    { imported: number; skipped: number; failed: number; blocked: number }
  >
}
function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
// The harness builds the Claude-compatible projects.json. Native backups are
// built in services/native-backup, which adds the chats on this device.
export async function exportClaudeProjects(signal?: AbortSignal) {
  const blob = await harnessAPI().download(
    '/v1/export',
    { format: 'claude-projects' },
    signal,
  )
  signal?.throwIfAborted()
  saveDownload(blob, 'projects.json')
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

const IMPORT_STATUS_POLL_MS = 2000
// A poll can fail transiently while a long job keeps running; only give up
// on the sequence once the chat service stays unreachable.
const MAX_CONSECUTIVE_STATUS_FAILURES = 5

// A job being followed has vanished, which happens only when the service
// that ran it restarted or reaped it; its outcome is unknown.
function isImportJobGone(cause: unknown): boolean {
  return cause instanceof HarnessError && cause.status === 404
}

function isImportJobFinished(status: ImportStatusResponse): boolean {
  return (
    status.status === 'completed' ||
    status.status === 'partial' ||
    status.status === 'failed'
  )
}

export interface ImportSequenceOptions {
  /** Called as each file starts uploading. */
  onUpload?: (fileIndex: number) => void
  /** Called with each status polled while an earlier file is processed. */
  onProcessing?: (fileIndex: number, status: ImportStatusResponse) => void
  wait?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/**
 * A file of a split import could not be uploaded, started, or followed to
 * completion. Records which file, and how many chats the earlier files
 * imported, so a partly finished import is not reported as nothing.
 */
export class ImportSequenceError extends Error {
  constructor(
    cause: unknown,
    readonly fileIndex: number,
    readonly importedBefore: number,
  ) {
    super(cause instanceof Error ? cause.message : 'Failed to start import')
    this.name = 'ImportSequenceError'
    this.cause = cause
  }
}

export interface ImportSequenceResult {
  /**
   * The last job's status: the one that failed or was interrupted, or the
   * final file's kickoff snapshot when every earlier file completed.
   */
  status: ImportStatusResponse
  /** Index into the files of the job `status` describes. */
  fileIndex: number
  /** Chats imported by the files that completed before `fileIndex`. */
  importedBefore: number
  /** The job at `fileIndex` was lost while it was processing. */
  interrupted: boolean
}

/**
 * Imports an export split across files as one job per file. The sync
 * service runs one import per account and refuses another while a job
 * runs, so each file but the last is processed to completion before the
 * next is uploaded, and the sequence stops at the first file that fails
 * so a later success never hides it. The last file's job is left running;
 * the user is emailed when it finishes. Errors are rethrown as an
 * ImportSequenceError.
 */
export async function runImports(
  source: string,
  files: readonly File[],
  options: ImportSequenceOptions = {},
): Promise<ImportSequenceResult> {
  if (files.length === 0) throw new Error('No export files were selected')
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let importedBefore = 0
  for (let fileIndex = 0; ; fileIndex++) {
    let status: ImportStatusResponse
    try {
      options.onUpload?.(fileIndex)
      status = await startImport(files[fileIndex], source, options.signal)
      const isLast = fileIndex === files.length - 1
      if (!isLast && !isImportJobFinished(status))
        options.onProcessing?.(fileIndex, status)
      let consecutiveFailures = 0
      while (!isLast && !isImportJobFinished(status)) {
        await wait(IMPORT_STATUS_POLL_MS)
        options.signal?.throwIfAborted()
        try {
          status = await importStatus(status.jobId!, options.signal)
          consecutiveFailures = 0
        } catch (cause) {
          if (isImportJobGone(cause))
            return { status, fileIndex, importedBefore, interrupted: true }
          if (
            options.signal?.aborted ||
            ++consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES
          )
            throw cause
          continue
        }
        options.onProcessing?.(fileIndex, status)
      }
      if (isLast || status.status === 'failed')
        return { status, fileIndex, importedBefore, interrupted: false }
    } catch (cause) {
      throw new ImportSequenceError(cause, fileIndex, importedBefore)
    }
    importedBefore += status.imported
  }
}
