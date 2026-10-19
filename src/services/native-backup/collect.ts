import {
  localThreadStore,
  type LocalAttachment,
  type LocalMessage,
  type LocalThread,
} from '@/services/harness/local-threads'
import { harnessAPI } from '@/services/harness/runtime'
import type { TimelineBlock } from '@/services/harness/types'
import { base64ToUint8Array } from '@/utils/binary-codec'
import { z } from 'zod'
import { NATIVE_BACKUP_LIMITS } from './constants'
import {
  deriveNativeBackupWarnings,
  type NativeBackupImageInput,
  type NativeBackupOmission,
  type NativeBackupV2Input,
} from './format'
import { detectNativeBackupImageMimeType } from './image-mime'
import { readNativeBackup, type NativeBackupContents } from './restore'
import {
  NativeBackupChatSchema,
  NativeBackupImageSchema,
  type NativeBackupChat,
} from './schemas'

// The harness builds a backup of the cloud's projects and chats; the chats
// kept on this device are added to it here, as main's backup included them.

export class NativeBackupCollectionError extends Error {
  constructor(
    public readonly kind: string,
    public readonly recordId: string,
    detail: string,
  ) {
    super(`Native backup collection failed for ${kind} ${recordId}: ${detail}`)
    this.name = 'NativeBackupCollectionError'
  }
}

export interface NativeBackupCollectionDependencies {
  downloadCloudBackup(signal: AbortSignal): Promise<Blob>
  readBackup(file: File, signal: AbortSignal): Promise<NativeBackupContents>
  localThreads(): Promise<LocalThread[]>
}

async function localThreads(): Promise<LocalThread[]> {
  const store = localThreadStore('device')
  const threads: LocalThread[] = []
  for (const summary of await store.list()) {
    const thread = await store.get(summary.id)
    if (thread) threads.push(thread)
  }
  return threads
}

const defaults: NativeBackupCollectionDependencies = {
  downloadCloudBackup: (signal) =>
    harnessAPI().download('/v1/export', { format: 'tinfoil-backup' }, signal),
  readBackup: (file, signal) => readNativeBackup(file, { signal }),
  localThreads,
}

// An item of a local chat that cannot be included is omitted from it.
class OmittedItem extends Error {
  constructor(
    readonly sourceId: string,
    readonly category: NativeBackupOmission['category'],
    readonly reason: string,
  ) {
    super(reason)
  }
}

const iso = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  throw new OmittedItem('timestamp', 'invalid', 'record_invalid')
}

const textOf = (timeline: TimelineBlock[] | undefined, type: string) =>
  (timeline ?? [])
    .filter((block) => block.type === type)
    .map((block) => block.content ?? '')
    .join('')

function millis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}

function parsedArguments(text: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// A reasoning block of the previous client records how long it took.
const duration = (block: TimelineBlock): unknown =>
  (block as unknown as { duration?: unknown }).duration

// The harness's backup timeline: text and reasoning blocks, and tool calls,
// whose results ride in a code execution call's output as the native format
// has no field for them.
function backupTimeline(timeline: TimelineBlock[] | undefined) {
  const blocks: Record<string, unknown>[] = []
  for (const block of timeline ?? []) {
    if (block.type === 'content')
      blocks.push({
        type: 'content',
        id: block.id,
        content: block.content ?? '',
      })
    else if (block.type === 'thinking')
      blocks.push({
        type: 'thinking',
        id: block.id,
        content: block.content ?? '',
        ...(typeof duration(block) === 'number'
          ? { duration: duration(block) }
          : {}),
        isThinking: false,
      })
    else if (block.type === 'tool_call') {
      const name = block.name ?? ''
      if (
        block.result !== undefined &&
        (!name.startsWith('render_') || name === 'render_link_preview')
      ) {
        blocks.push({
          type: 'code_exec',
          id: block.id,
          calls: [
            {
              id: block.toolCallId || block.id,
              toolName: name,
              arguments: parsedArguments(block.arguments),
              status: 'completed',
              output: JSON.stringify(block.result),
            },
          ],
        })
        continue
      }
      const resolvedAt = millis(block.resolvedAt)
      blocks.push({
        type: 'tool_call',
        id: block.id,
        toolCallId: block.toolCallId || block.id,
        name,
        arguments: block.arguments ?? '',
        ...(block.resolution ? { resolution: block.resolution } : {}),
        ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      })
    }
  }
  return blocks
}

interface ChatCollection {
  chat: NativeBackupChat
  images: NativeBackupImageInput[]
  omissions: NativeBackupOmission[]
}

// A local chat in the backup's format, with its images. An image that cannot
// be included is left out of its message and listed as omitted, as main's
// backup did.
function collectLocalChat(thread: LocalThread): ChatCollection {
  const images: NativeBackupImageInput[] = []
  const omissions: NativeBackupOmission[] = []
  const image = (
    messageIndex: number,
    attachmentIndex: number,
    attachment: LocalAttachment,
    base64: string | undefined,
    page?: number,
  ): string => {
    const id = JSON.stringify(
      page === undefined
        ? [
            'attachment',
            thread.id,
            messageIndex,
            attachmentIndex,
            attachment.id,
          ]
        : [
            'page',
            thread.id,
            messageIndex,
            attachmentIndex,
            attachment.id,
            page,
          ],
    )
    // An image kept only as a thumbnail has no bytes to back up.
    if (!base64)
      throw new OmittedItem(id, 'unavailable', 'attachment_not_found')
    let bytes: Uint8Array
    try {
      bytes = base64ToUint8Array(base64)
    } catch {
      throw new OmittedItem(id, 'invalid', 'attachment_payload_invalid')
    }
    const mimeType = detectNativeBackupImageMimeType(bytes)
    if (!mimeType)
      throw new OmittedItem(id, 'invalid', 'attachment_type_unsupported')
    if (bytes.length > NATIVE_BACKUP_LIMITS.imageBytes)
      throw new NativeBackupCollectionError(
        'limits',
        'collection',
        'image size limit exceeded',
      )
    const metadata = NativeBackupImageSchema.parse({
      id,
      chatId: thread.id,
      messageIndex,
      attachmentId: attachment.id,
      ...(page !== undefined ? { page } : {}),
      fileName:
        page === undefined
          ? attachment.fileName
          : `${attachment.id}-page-${page}.jpg`,
      mimeType,
      sizeBytes: bytes.length,
      ...(page === undefined && attachment.description
        ? { description: attachment.description }
        : {}),
    })
    images.push({ metadata, bytes })
    return id
  }
  const omit = (error: unknown) => {
    if (!(error instanceof OmittedItem)) throw error
    omissions.push({
      kind: 'attachment',
      source_id: error.sourceId,
      parent_source_id: thread.id,
      category: error.category,
      reason: error.reason,
    })
  }
  const attachments = (
    message: LocalMessage,
    messageIndex: number,
  ): Record<string, unknown>[] =>
    (message.attachments ?? []).flatMap<Record<string, unknown>>(
      (attachment, attachmentIndex) => {
        if (attachment.type !== 'image')
          return [
            {
              type: 'document',
              id: attachment.id,
              fileName: attachment.fileName,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
              ...(attachment.textContent !== undefined
                ? { textContent: attachment.textContent }
                : {}),
              ...(attachment.description
                ? { description: attachment.description }
                : {}),
              ...(Number.isInteger(attachment.fileSize) &&
              attachment.fileSize! >= 0
                ? { fileSize: attachment.fileSize }
                : {}),
              ...(attachment.pages
                ? {
                    pages: attachment.pages.map((page) => {
                      let imageId: string | undefined
                      if (page.image)
                        try {
                          imageId = image(
                            messageIndex,
                            attachmentIndex,
                            attachment,
                            page.image,
                            page.page,
                          )
                        } catch (error) {
                          omit(error)
                        }
                      return {
                        page: page.page,
                        text: page.text ?? '',
                        is_scanned: page.is_scanned === true,
                        ...(imageId ? { imageId } : {}),
                      }
                    }),
                  }
                : {}),
            },
          ]
        try {
          return [
            {
              type: 'image',
              id: attachment.id,
              imageId: image(
                messageIndex,
                attachmentIndex,
                attachment,
                attachment.base64,
              ),
            },
          ]
        } catch (error) {
          omit(error)
          return []
        }
      },
    )
  const chat = NativeBackupChatSchema.parse({
    id: thread.id,
    title: thread.title,
    titleState: thread.titleState,
    createdAt: iso(thread.createdAt, thread.updatedAt),
    updatedAt: iso(thread.updatedAt, thread.createdAt),
    ...(thread.presetId ? { presetId: thread.presetId } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.webSearchEnabled !== undefined
      ? { webSearchEnabled: thread.webSearchEnabled }
      : {}),
    messages: thread.messages.map((message, messageIndex) => {
      const timeline = backupTimeline(message.timeline)
      const backupAttachments = attachments(message, messageIndex)
      const hasThinking = message.timeline?.some(
        (block) => block.type === 'thinking',
      )
      return {
        role: message.role,
        content:
          message.role === 'assistant'
            ? message.content || textOf(message.timeline, 'content')
            : message.content,
        timestamp: iso(message.createdAt, thread.createdAt),
        ...(message.modelDisplayName
          ? { modelDisplayName: message.modelDisplayName }
          : {}),
        ...(hasThinking
          ? { thoughts: textOf(message.timeline, 'thinking') }
          : {}),
        ...(message.isError ? { isError: true } : {}),
        ...(message.quote ? { quote: message.quote } : {}),
        ...(timeline.length > 0 ? { timeline } : {}),
        ...(backupAttachments.length > 0
          ? { attachments: backupAttachments }
          : {}),
      }
    }),
  })
  return { chat, images, omissions }
}

interface LocalCollection {
  chats: NativeBackupChat[]
  images: NativeBackupImageInput[]
  omissions: NativeBackupOmission[]
}

function collectLocalChats(
  threads: LocalThread[],
  cloudChatIds: ReadonlySet<string>,
): LocalCollection {
  const collection: LocalCollection = { chats: [], images: [], omissions: [] }
  for (const thread of threads) {
    // A chat moved to the cloud whose device copy remains is backed up once.
    if (cloudChatIds.has(thread.id)) {
      collection.omissions.push({
        kind: 'local_chat',
        source_id: thread.id,
        category: 'invalid',
        reason: 'duplicate_chat_id',
      })
      continue
    }
    try {
      const { chat, images, omissions } = collectLocalChat(thread)
      collection.chats.push(chat)
      collection.images.push(...images)
      collection.omissions.push(...omissions)
    } catch (error) {
      if (!(error instanceof OmittedItem) && !(error instanceof z.ZodError))
        throw error
      collection.omissions.push({
        kind: 'local_chat',
        source_id: thread.id,
        category: 'invalid',
        reason: 'record_invalid',
      })
    }
  }
  return collection
}

// The local chats change as replies stream in; a backup taken while they do
// is retried, and then marked as a partial snapshot, as main's was.
const snapshot = (threads: LocalThread[]) => JSON.stringify(threads)

export async function collectNativeBackupV2(
  signal: AbortSignal,
  deps: NativeBackupCollectionDependencies = defaults,
): Promise<NativeBackupV2Input> {
  signal.throwIfAborted()
  const archive = await deps.downloadCloudBackup(signal)
  signal.throwIfAborted()
  const cloud = await deps.readBackup(
    new File([archive], 'tinfoil-backup.zip', { type: 'application/zip' }),
    signal,
  )
  signal.throwIfAborted()
  const cloudChatIds = new Set(cloud.cloudChats.map(({ id }) => id))
  let local: LocalCollection
  let unstable = false
  for (let attempt = 0; ; attempt++) {
    const threads = await deps.localThreads()
    signal.throwIfAborted()
    local = collectLocalChats(threads, cloudChatIds)
    if (snapshot(await deps.localThreads()) === snapshot(threads)) break
    signal.throwIfAborted()
    if (attempt + 1 >= NATIVE_BACKUP_LIMITS.localInventoryAttempts) {
      unstable = true
      break
    }
  }
  const omissions: NativeBackupOmission[] = [
    ...(cloud.backup.version === 2 ? cloud.backup.omissions : []),
    ...local.omissions,
    ...(unstable
      ? [
          {
            kind: 'local_inventory' as const,
            source_id: 'eligible_local_chats',
            category: 'unstable' as const,
            reason: 'inventory_did_not_converge',
          },
        ]
      : []),
  ]
  return {
    backupId: cloud.backup.backup_id,
    createdAt: cloud.backup.created_at,
    projects: cloud.projects,
    projectDocuments: cloud.documents,
    cloudChats: cloud.cloudChats,
    localChats: [...cloud.localChats, ...local.chats],
    relationships: {
      ...cloud.relationships,
      chatImages: [
        ...cloud.relationships.chatImages,
        ...local.images.map(({ metadata }) => ({
          chatId: metadata.chatId,
          imageId: metadata.id,
        })),
      ],
    },
    images: [...cloud.images, ...local.images],
    omissions,
    warnings: deriveNativeBackupWarnings(omissions),
  }
}
