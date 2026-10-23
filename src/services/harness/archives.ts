import type { AttachmentOriginal } from '@/services/storage/indexed-db'
import { isThread, localThreadStore, type Originals } from './local-threads'
import { imageBlob } from './open-attachments'
import { ERROR_CODES, ROUTES } from './protocol'
import { harnessAPI, type HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type {
  AttachmentDescriptor,
  HarnessErrorBody,
  StoredThread,
} from './types'
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

// A Tinfoil backup, or the chats as conversations, which Tinfoil and other
// chat apps import.
type ExportFormat = 'native' | 'conversations'
const EXPORT_FILENAMES: Record<ExportFormat, string> = {
  native: 'tinfoil-backup.zip',
  conversations: 'tinfoil-chats.zip',
}

// The chats a signed-in account keeps on this device, or a signed-out
// visitor in this tab.
const deviceStore = (api: HarnessAPI) =>
  localThreadStore(api.userId ? 'device' : 'tab')

// Reads an archive as it arrives, reporting the bytes received so far.
async function receive(
  response: Response,
  onProgress?: (received: number) => void,
): Promise<Blob> {
  const chunks: BlobPart[] = []
  let received = 0
  const reader = response.body?.getReader()
  for (;;) {
    const chunk = await reader?.read()
    if (!chunk || chunk.done) break
    chunks.push(chunk.value as Uint8Array<ArrayBuffer>)
    received += chunk.value.length
    onProgress?.(received)
  }
  return new Blob(chunks, {
    type: response.headers.get('Content-Type') ?? '',
  })
}

interface ExportOptions {
  // Include the account's cloud chats and projects, which the content key
  // opens.
  cloud: boolean
  signal?: AbortSignal
  onProgress?: (received: number) => void
}

// The chat service writes one archive of the chats kept here, sent as they
// are stored with the originals of their images, and of the account's cloud
// data. With nothing to export nothing is sent, and false is returned.
export async function exportArchive(
  format: ExportFormat,
  { cloud, signal, onProgress }: ExportOptions,
): Promise<boolean> {
  const api = harnessAPI()
  const key = cloud ? api.key() : undefined
  const form = new FormData()
  form.append('options', JSON.stringify({ format, ...(key ? { key } : {}) }))
  const store = deviceStore(api)
  // A fork keeps the attachments of its chat, whose originals go once.
  const sent = new Set<string>()
  let chats = 0
  for (const { id } of await store.list()) {
    signal?.throwIfAborted()
    const thread = await store.get(id)
    if (!thread) continue
    form.append('thread', JSON.stringify(thread))
    chats++
    const attachmentIds = thread.messages
      .flatMap((message) => message.attachments ?? [])
      .map((attachment) => attachment.id)
      .filter((attachmentId) => !sent.has(attachmentId))
    for (const [attachmentId, original] of await store.originals(
      id,
      attachmentIds,
    )) {
      sent.add(attachmentId)
      const image = imageBlob(original)
      form.append('file', new File([image], attachmentId, { type: image.type }))
    }
  }
  if (!key && chats === 0) return false
  const response = await api.multipart(ROUTES.export, form, {
    signal,
    keyless: !key,
  })
  const archive = await receive(response, onProgress)
  signal?.throwIfAborted()
  saveDownload(archive, EXPORT_FILENAMES[format])
  return true
}

// What a Claude projects export holds.
export interface ClaudeProjectsExport {
  projects: number
  documents: number
}

function countClaudeProjects(text: string): ClaudeProjectsExport {
  let projects: unknown
  try {
    projects = JSON.parse(text)
  } catch {
    projects = null
  }
  if (!Array.isArray(projects))
    throw new HarnessError({
      code: ERROR_CODES.invalidStream,
      message: 'The chat service returned an invalid export.',
    })
  return {
    projects: projects.length,
    documents: projects.reduce<number>(
      (count, project) =>
        count + (Array.isArray(project?.docs) ? project.docs.length : 0),
      0,
    ),
  }
}

// The chat service writes the Claude-compatible projects.json, which is
// saved unless it holds no projects.
export async function exportClaudeProjects(
  signal?: AbortSignal,
): Promise<ClaudeProjectsExport> {
  const api = harnessAPI()
  const form = new FormData()
  form.append(
    'options',
    JSON.stringify({ format: 'claude-projects', key: api.key() }),
  )
  const response = await api.multipart(ROUTES.export, form, { signal })
  const blob = await response.blob()
  signal?.throwIfAborted()
  const exported = countClaudeProjects(await blob.text())
  if (exported.projects > 0) saveDownload(blob, 'projects.json')
  return exported
}

export type ImportTarget = 'cloud' | 'device'

// The chat service's last line for an imported file: the cloud job it
// started, if any, and what it could not import as it was.
interface ImportDone {
  jobId: string | null
  warnings: string[]
}

interface FileImport extends ImportDone {
  // Chats stored on this device, and chats it holds already.
  stored: number
  skipped: number
}

const invalidImport = () =>
  new HarnessError({
    code: ERROR_CODES.invalidStream,
    message: 'The chat service returned an invalid import.',
  })

function importLine(text: string): { thread: StoredThread } | ImportDone {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidImport()
  }
  const { thread, done, error } = (value ?? {}) as {
    thread?: unknown
    done?: unknown
    error?: unknown
  }
  if (isThread(thread)) return { thread }
  // A failure after the first line ends the import; the chats stored before
  // it stay stored.
  const { code, message } = (error ?? {}) as Partial<HarnessErrorBody>
  if (typeof code === 'string' && typeof message === 'string')
    throw new HarnessError(error as HarnessErrorBody)
  const { jobId, warnings = [] } = (done ?? {}) as Partial<ImportDone>
  if (
    done &&
    (jobId === null || typeof jobId === 'string') &&
    Array.isArray(warnings) &&
    warnings.every((warning) => typeof warning === 'string')
  )
    return { jobId, warnings }
  throw invalidImport()
}

// The lines of an import's response, each a chat for this device, and last
// the line that ends it.
async function* importLines(
  response: Response,
): AsyncGenerator<{ thread: StoredThread } | ImportDone> {
  const reader = response.body?.getReader()
  if (!reader) throw invalidImport()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = chunk.done ? '' : lines.pop()!
      for (const line of lines) if (line.trim()) yield importLine(line)
      if (chunk.done) return
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

// An imported image carries the archive's original, which its mimeType
// describes, beside the copy models read.
type ImportedAttachment = AttachmentDescriptor & { originalBase64?: string }

// This device keeps the originals of an imported chat's images apart, to
// show, and stores the thread without them.
function splitOriginals(imported: StoredThread): {
  thread: StoredThread
  originals: Originals
} {
  const originals = new Map<string, AttachmentOriginal>()
  const messages = imported.messages.map((message) => {
    if (!message.attachments) return message
    const attachments = message.attachments.map((attachment) => {
      const { originalBase64, ...kept } = attachment as ImportedAttachment
      if (originalBase64)
        originals.set(kept.id, {
          base64: originalBase64,
          mimeType: kept.mimeType,
        })
      return kept
    })
    return { ...message, attachments }
  })
  return { thread: { ...imported, messages }, originals }
}

// The chat service reads an export or backup in any format it knows. It
// stores cloud data in a job, which the content key opens; the chats for
// this device come back and are stored here as they arrive. A chat this
// device holds already is kept as it is.
async function importFile(
  file: File,
  target: ImportTarget,
  signal?: AbortSignal,
  onStored?: (stored: number) => void,
): Promise<FileImport> {
  const api = harnessAPI()
  const key = target === 'cloud' ? api.key() : undefined
  const form = new FormData()
  form.append('options', JSON.stringify({ target, ...(key ? { key } : {}) }))
  form.append('file', file)
  const response = await api.multipart(ROUTES.import, form, {
    signal,
    keyless: !key,
  })
  const store = deviceStore(api)
  let stored = 0
  let skipped = 0
  for await (const line of importLines(response)) {
    if (!('thread' in line)) return { ...line, stored, skipped }
    signal?.throwIfAborted()
    const { thread, originals } = splitOriginals(line.thread)
    if (await store.add(thread, originals)) {
      stored++
      onStored?.(stored)
    } else skipped++
  }
  throw new HarnessError({
    code: ERROR_CODES.streamInterrupted,
    message: 'The import ended before it finished.',
  })
}

async function jobStatus(
  api: HarnessAPI,
  jobId: string,
  signal?: AbortSignal,
): Promise<ImportStatusResponse> {
  const status = await api.post<ImportStatusResponse>(
    ROUTES.importStatus,
    { jobId },
    { signal, keyless: true },
  )
  return { ...status, jobId }
}

export function importStatus(jobId: string, signal?: AbortSignal) {
  return jobStatus(harnessAPI(), jobId, signal)
}

// Resolves after a delay, or rejects once the signal aborts.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
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
  /** Called with the chats a file has stored on this device so far. */
  onStored?: (fileIndex: number, stored: number) => void
  wait?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/**
 * A file of a split import could not be uploaded, started, or followed to
 * completion. Records which file, how many chats were imported before it
 * failed, and what the chat service could not import as it was until then,
 * so a partly finished import is not reported as nothing.
 */
export class ImportSequenceError extends Error {
  constructor(
    cause: unknown,
    readonly fileIndex: number,
    readonly imported: number,
    readonly warnings: string[],
  ) {
    super(cause instanceof Error ? cause.message : 'Failed to start import')
    this.name = 'ImportSequenceError'
    this.cause = cause
  }
}

export interface ImportSequenceResult {
  /**
   * The last cloud job's status: the one that failed or was interrupted, or
   * the final file's kickoff snapshot. Null when that file started no job.
   */
  status: ImportStatusResponse | null
  /** Index into the files of the file `status` describes. */
  fileIndex: number
  /**
   * Chats imported apart from those `status` counts: by the cloud jobs of
   * earlier files, and every chat stored on this device.
   */
  imported: number
  /** Chats for this device it held already, which were kept as they were. */
  skipped: number
  /** The job at `fileIndex` was lost while it was processing. */
  interrupted: boolean
  /**
   * What the chat service could not import as it was, from every file and
   * the last status of its cloud job.
   */
  warnings: string[]
}

/**
 * Imports an export split across files a file at a time. The sync service
 * runs one import per account and refuses another while a job runs, so the
 * cloud job of each file but the last is processed to completion before the
 * next is uploaded, and the sequence stops at the first job that fails so a
 * later success never hides it. The last file's job is left running; the
 * user is emailed when it finishes. Errors are rethrown as an
 * ImportSequenceError.
 */
export async function runImports(
  target: ImportTarget,
  files: readonly File[],
  options: ImportSequenceOptions = {},
): Promise<ImportSequenceResult> {
  if (files.length === 0) throw new Error('No export files were selected')
  const api = harnessAPI()
  const wait = options.wait ?? ((ms: number) => pause(ms, options.signal))
  let imported = 0
  let skipped = 0
  const warnings: string[] = []
  for (let fileIndex = 0; ; fileIndex++) {
    const isLast = fileIndex === files.length - 1
    let status: ImportStatusResponse | null = null
    try {
      options.onUpload?.(fileIndex)
      // Counted as each is stored, so a file that fails partway still counts
      // the chats it kept.
      const file = await importFile(
        files[fileIndex],
        target,
        options.signal,
        (stored) => {
          imported++
          options.onStored?.(fileIndex, stored)
        },
      )
      warnings.push(...file.warnings)
      skipped += file.skipped
      if (file.jobId) {
        status = await jobStatus(api, file.jobId, options.signal)
        if (!isLast && !isImportJobFinished(status))
          options.onProcessing?.(fileIndex, status)
        let consecutiveFailures = 0
        while (!isLast && !isImportJobFinished(status)) {
          await wait(IMPORT_STATUS_POLL_MS)
          options.signal?.throwIfAborted()
          try {
            status = await jobStatus(api, file.jobId, options.signal)
            consecutiveFailures = 0
          } catch (cause) {
            if (isImportJobGone(cause))
              return {
                status,
                fileIndex,
                imported,
                skipped,
                interrupted: true,
                warnings: [...warnings, ...(status.warnings ?? [])],
              }
            if (
              options.signal?.aborted ||
              ++consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES
            )
              throw cause
            continue
          }
          options.onProcessing?.(fileIndex, status)
        }
        warnings.push(...(status.warnings ?? []))
      }
      if (isLast || status?.status === 'failed')
        return {
          status,
          fileIndex,
          imported,
          skipped,
          interrupted: false,
          warnings,
        }
    } catch (cause) {
      throw new ImportSequenceError(cause, fileIndex, imported, [
        ...warnings,
        ...(status?.warnings ?? []),
      ])
    }
    imported += status?.imported ?? 0
  }
}

const RESTORE_POLL_MS = 1500
const MAX_RESTORE_POLLS = 20

export interface RestoreResult {
  /**
   * 'pending': the cloud job still runs. 'interrupted': the chat service no
   * longer knows the job, as it restarted or reaped it, so only the job's
   * email tells its outcome.
   */
  state: 'completed' | 'partial' | 'failed' | 'pending' | 'interrupted'
  /** The cloud job as last polled, when the backup started one. */
  status: ImportStatusResponse | null
  stored: number
  skipped: number
  warnings: string[]
}

interface RestoreEvents {
  onStarted?(status: ImportStatusResponse): void
  onPhase?(phase?: string): void
}

// A backup is restored to the cloud with cloud sync, and its chats kept on a
// device, or all of it without cloud sync, are stored on this device. The
// cloud job is followed for a while; a longer one goes on, and the user is
// emailed when it ends.
export async function restoreBackup(
  file: File,
  signal: AbortSignal,
  events: RestoreEvents = {},
): Promise<RestoreResult> {
  const api = harnessAPI()
  const { jobId, ...restored } = await importFile(
    file,
    api.cloud ? 'cloud' : 'device',
    signal,
  )
  if (!jobId)
    return {
      ...restored,
      status: null,
      state: restored.warnings.length ? 'partial' : 'completed',
    }
  let status = await jobStatus(api, jobId, signal)
  events.onStarted?.(status)
  events.onPhase?.(status.phase)
  for (
    let poll = 0;
    !isImportJobFinished(status) && poll < MAX_RESTORE_POLLS;
    poll++
  ) {
    await pause(RESTORE_POLL_MS, api.signal({ signal, keyless: true }))
    try {
      status = await jobStatus(api, jobId, signal)
    } catch (cause) {
      if (isImportJobGone(cause))
        return { ...restored, status, state: 'interrupted' }
      throw cause
    }
    events.onPhase?.(status.phase)
  }
  if (!isImportJobFinished(status))
    return { ...restored, status, state: 'pending' }
  if (status.status === 'failed')
    return { ...restored, status, state: 'failed' }
  const partial =
    status.status === 'partial' ||
    restored.warnings.length > 0 ||
    !!status.warnings?.length ||
    !!status.errors?.length
  return { ...restored, status, state: partial ? 'partial' : 'completed' }
}
