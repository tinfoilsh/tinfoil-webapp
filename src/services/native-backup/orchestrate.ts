import type { Chat } from '@/components/chat/types'
import { runOffDeviceImport } from '@/services/chat-import/off-device-import'
import { chatStorage } from '@/services/storage/chat-storage'
import { SyncEnclaveError } from '@/services/sync-enclave'
// prettier-ignore
import { importStatus,type ImportFailureReason,type ImportStatusResponse } from '@/services/sync-enclave/sync-api'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { NATIVE_BACKUP_VERSION_V2 } from './constants'
import {
  forEachNativeBackupLocalImage,
  validateAndPackageNativeBackup,
  type ValidatedNativeRestore,
} from './restore'
import type { NativeBackupImage } from './schemas'

const POLL_INTERVAL_MS = 1500
const MAX_POLL_ATTEMPTS = 20
// prettier-ignore
export const NATIVE_RESTORE_KINDS = ['projects', 'project_documents', 'cloud_chats', 'local_chats', 'attachments'] as const
export type NativeRestoreKind = (typeof NATIVE_RESTORE_KINDS)[number]
// prettier-ignore
export type NativeRestoreCount = { imported: number; skipped: number; failed: number; blocked: number; warnings: string[]; errors: string[] }
/**
 * 'interrupted' means the enclave no longer knows the job (it restarted
 * or reaped it) while we were still polling, so the outcome is unknown
 * to the browser; the completion or failure email is the only signal.
 */
// prettier-ignore
export type NativeRestoreResult = { state: 'completed' | 'partial' | 'failed' | 'pending' | 'interrupted'; jobId?: string; failureReason?: ImportFailureReason; report: Record<NativeRestoreKind, NativeRestoreCount> }
// prettier-ignore
type Dependencies = { validate: typeof validateAndPackageNativeBackup; upload: typeof runOffDeviceImport; status: typeof importStatus; forEachImage: typeof forEachNativeBackupLocalImage; getChat(id: string): Promise<Chat | null>; saveChat(chat: Chat, skipCloudSync?: boolean): Promise<Chat | null>; wait(ms: number, signal: AbortSignal): Promise<void> }
// prettier-ignore
type RestoreEvents = { onStarted?(status: ImportStatusResponse): void; onPhase?(phase?: string): void }

const defaults: Dependencies = {
  validate: validateAndPackageNativeBackup,
  upload: runOffDeviceImport,
  status: importStatus,
  forEachImage: forEachNativeBackupLocalImage,
  getChat: chatStorage.getChat.bind(chatStorage),
  saveChat: chatStorage.saveChatIfAllowed.bind(chatStorage),
  wait: (ms, signal) => {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const complete = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      const timer = window.setTimeout(complete, ms)
      signal.addEventListener('abort', abort, { once: true })
    })
  },
}

// A job we were just polling has vanished from the enclave, which only
// happens when the enclave restarted or reaped it.
function isImportJobGone(cause: unknown): boolean {
  return cause instanceof SyncEnclaveError && cause.status === 404
}

function emptyReport(): NativeRestoreResult['report'] {
  const empty = (): NativeRestoreCount => ({
    imported: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  })
  return {
    projects: empty(),
    project_documents: empty(),
    cloud_chats: empty(),
    local_chats: empty(),
    attachments: empty(),
  }
}

function applySourceBackupWarnings(
  validated: ValidatedNativeRestore,
  report: NativeRestoreResult['report'],
) {
  if (
    validated.backup.version !== NATIVE_BACKUP_VERSION_V2 ||
    validated.backup.complete
  )
    return
  const targets: Partial<
    Record<
      (typeof validated.backup.omissions)[number]['kind'],
      NativeRestoreKind
    >
  > = {
    project: 'projects',
    project_document: 'project_documents',
    cloud_chat: 'cloud_chats',
    local_chat: 'local_chats',
    attachment: 'attachments',
  }
  const counts = new Map<NativeRestoreKind, number>()
  for (const omission of validated.backup.omissions) {
    const target = targets[omission.kind]
    if (!target) continue
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  const labels: Record<NativeRestoreKind, [string, string]> = {
    projects: ['project', 'projects'],
    project_documents: ['project document', 'project documents'],
    cloud_chats: ['cloud chat', 'cloud chats'],
    local_chats: ['local chat', 'local chats'],
    attachments: ['attachment', 'attachments'],
  }
  for (const [kind, count] of counts)
    report[kind].warnings.push(
      `Source archive omitted ${count} ${labels[kind][count === 1 ? 0 : 1]}.`,
    )
  const localChatIds = new Set(validated.local.chats.map(({ id }) => id))
  const relationshipCounts = new Map<NativeRestoreKind, number>()
  for (const omission of validated.backup.omissions) {
    if (omission.kind !== 'relationship') continue
    const target = localChatIds.has(omission.source_id)
      ? 'local_chats'
      : 'cloud_chats'
    relationshipCounts.set(target, (relationshipCounts.get(target) ?? 0) + 1)
  }
  for (const [target, count] of relationshipCounts)
    report[target].warnings.push(
      `Source archive adjusted ${count} relationship${count === 1 ? '' : 's'} to keep restored data valid.`,
    )
  if (
    validated.backup.warnings.some(
      ({ code }) => code === 'local_inventory_unstable',
    )
  )
    report.local_chats.warnings.push(
      'Local chats changed repeatedly during export; included local chats are a partial snapshot.',
    )
}

// prettier-ignore
function destinationChatId(ownerId: string, backupId: string, sourceId: string) {
  const input = new TextEncoder().encode(`${ownerId}\0${backupId}\0${sourceId}`)
  return `native-${bytesToHex(sha256(input))}`
}

function applyImage(chat: Chat, image: NativeBackupImage, bytes: Uint8Array) {
  const message = chat.messages[image.messageIndex]
  const base64 = uint8ArrayToBase64(bytes)
  if (image.legacyIndex !== undefined) {
    message.imageData![image.legacyIndex] = { base64, mimeType: image.mimeType }
    return
  }
  const index =
    message.attachments?.findIndex(({ id }) => id === image.attachmentId) ?? -1
  const attachment = message.attachments?.[index]
  if (!attachment) throw new Error('Backup image attachment is missing')
  if (image.page !== undefined) {
    const page = attachment.pages?.find(({ page }) => page === image.page)
    if (!page) throw new Error('Backup image page is missing')
    page.image = base64
  } else {
    // prettier-ignore
    message.attachments![index] = { id: attachment.id, type: 'image', fileName: image.fileName, mimeType: image.mimeType, fileSize: image.sizeBytes, description: image.description, base64 }
  }
}

function normalizeChat(
  source: ValidatedNativeRestore['local']['chats'][number],
  id: string,
  ownerId: string,
  projectId: string | undefined,
  images: ValidatedNativeRestore['local']['images'],
): Chat {
  const imageById = new Map(
    images.map(({ metadata }) => [metadata.id, metadata]),
  )
  return {
    id,
    title: source.title,
    titleState: source.titleState,
    messages: source.messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp),
      imageData: message.imageData?.map(({ mimeType }) => ({
        base64: '',
        mimeType,
      })),
      attachments: message.attachments?.map((attachment) => {
        if (attachment.type === 'document') {
          return {
            ...attachment,
            pages: attachment.pages?.map(({ imageId: _imageId, ...page }) => ({
              ...page,
              image: '',
            })),
          }
        }
        const image = imageById.get(attachment.imageId)
        if (!image) throw new Error('Backup image attachment is missing')
        return {
          id: attachment.id,
          type: 'image' as const,
          fileName: image.fileName,
          mimeType: image.mimeType,
          fileSize: image.sizeBytes,
          description: image.description,
        }
      }),
    })),
    createdAt: new Date(source.createdAt),
    updatedAt: source.updatedAt,
    projectId,
    presetId: source.presetId,
    model: source.model,
    webSearchEnabled: source.webSearchEnabled,
    isLocalOnly: true,
    syncUserId: ownerId,
  }
}

function applyCloudReport(
  status: ImportStatusResponse,
  report: NativeRestoreResult['report'],
  fallback: NonNullable<
    ValidatedNativeRestore['cloud']
  >['manifest']['counts'] & {
    images: number
  },
) {
  // prettier-ignore
  const aliases: Record<string, NativeRestoreKind> = { project: 'projects', document: 'project_documents', chat: 'cloud_chats' }
  for (const [kind, outcome] of Object.entries(status.counts ?? {})) {
    const target = aliases[kind]
    if (target) Object.assign(report[target], outcome)
  }
  if (status.status === 'completed' && !status.counts) {
    report.cloud_chats.failed = status.failed
    report.projects.imported = fallback.projects
    report.project_documents.imported = fallback.documents
    report.cloud_chats.imported = fallback.chats
    report.attachments.imported = fallback.images
  }
  report.attachments.warnings.push(...(status.warnings ?? []))
  report.cloud_chats.errors.push(...(status.errors ?? []))
  if (status.status === 'failed' && !status.counts)
    report.cloud_chats.failed = status.failed
}

async function restoreLocalChats(
  validated: ValidatedNativeRestore,
  ownerId: string,
  projectMap: Record<string, string>,
  report: NativeRestoreResult['report'],
  signal: AbortSignal,
  dependencies: Dependencies,
) {
  for (const source of validated.local.chats) {
    signal.throwIfAborted()
    const id = destinationChatId(ownerId, validated.backup.backup_id, source.id)
    const existing = await dependencies.getChat(id)
    if (existing) {
      const existingOwner =
        existing.syncUserId ?? (existing as Chat & { userId?: string }).userId
      const bucket = existingOwner === ownerId ? 'skipped' : 'blocked'
      report.local_chats[bucket]++
      // prettier-ignore
      report.attachments[bucket] += validated.local.images.filter(({ metadata }) => metadata.chatId === source.id).length
      continue
    }
    let projectId = source.projectId ? projectMap[source.projectId] : undefined
    if (source.projectId && !projectId) {
      report.local_chats.warnings.push(
        `Restored "${source.title}" without its unavailable project.`,
      )
      projectId = undefined
    }
    const sourceImages = validated.local.images.filter(
      ({ metadata }) => metadata.chatId === source.id,
    )
    try {
      const chat = normalizeChat(source, id, ownerId, projectId, sourceImages)
      // prettier-ignore
      await dependencies.forEachImage(sourceImages, ({ metadata, bytes }) => applyImage(chat, metadata, bytes), { signal })
      if (!(await dependencies.saveChat(chat, true)))
        throw new Error('Restored chat was not saved')
      report.local_chats.imported++
      report.attachments.imported += sourceImages.length
    } catch {
      signal.throwIfAborted()
      report.local_chats.failed++
      report.attachments.failed += sourceImages.length
    }
  }
}

export async function restoreNativeBackup(
  file: File,
  ownerId: string,
  signal: AbortSignal,
  events: RestoreEvents = {},
  dependencies: Dependencies = defaults,
): Promise<NativeRestoreResult> {
  if (!ownerId.trim()) throw new Error('Sign in before restoring a backup')
  const report = emptyReport()
  const validated = await dependencies.validate(file, { signal })
  applySourceBackupWarnings(validated, report)
  let status: ImportStatusResponse | null = null
  let jobId: string | undefined
  if (validated.cloud) {
    const { upload } = validated.cloud
    try {
      // prettier-ignore
      const packageFile = upload.kind === 'blob' ? new File([upload.blob], upload.filename, { type: 'application/zip' }) : await upload.handle.getFile()
      const started = await dependencies.upload('tinfoil_backup', packageFile, {
        signal,
      })
      jobId = started.jobId
      status = started.status
      events.onStarted?.(status)
      events.onPhase?.(status.phase)
      for (
        let attempt = 0;
        status.status !== 'completed' &&
        status.status !== 'failed' &&
        attempt < MAX_POLL_ATTEMPTS;
        attempt++
      ) {
        await dependencies.wait(POLL_INTERVAL_MS, signal)
        try {
          status = await dependencies.status(jobId, signal)
        } catch (cause) {
          if (isImportJobGone(cause))
            return { state: 'interrupted', jobId, report }
          throw cause
        }
        events.onPhase?.(status.phase)
      }
    } finally {
      if (upload.kind === 'file') await upload.cleanup()
    }
    applyCloudReport(status!, report, {
      ...validated.cloud.manifest.counts,
      images:
        (validated.backup.counts?.images ??
          validated.cloud.manifest.counts.blobs) -
        validated.local.images.length,
    })
    if (status!.status !== 'completed' && status!.status !== 'failed')
      return { state: 'pending', jobId, report }
    if (status!.status === 'failed')
      // prettier-ignore
      return { state: 'failed', jobId, failureReason: status!.failure_reason, report }
  }
  await restoreLocalChats(
    validated,
    ownerId,
    status?.project_mappings ?? {},
    report,
    signal,
    dependencies,
  )
  const partial = Object.values(report).some(
    ({ failed, blocked, warnings, errors }) =>
      failed || blocked || warnings.length || errors.length,
  )
  return { state: partial ? 'partial' : 'completed', jobId, report }
}
