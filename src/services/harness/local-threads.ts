import type { Chat } from '@/components/chat/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  indexedDBStorage,
  type IndexedDBStorage,
  type Chat as StoredChatRow,
} from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { logError } from '@/utils/error-handling'
import { harnessAPI } from './runtime'
import { MAX_TURN_REQUEST_BYTES, requestBytes } from './shares'
import { HarnessError } from './sse'
import type {
  AttachmentDescriptor,
  Message,
  StoredThread,
  Thread,
  ThreadMessage,
  ThreadSummary,
} from './types'

// A chat kept on this device is a thread in the harness's format. A turn
// sends it back as the thread, and the run's final event returns the
// updated thread, which replaces it.

export interface LocalThreadStore {
  list(): Promise<ThreadSummary[]>
  get(id: string): Promise<StoredThread | null>
  // Reads, changes, and writes one thread at a time, so concurrent runs of
  // the same chat cannot lose each other's messages. Returning null skips
  // the write, as does a chat deleted in the meantime.
  update(
    id: string,
    change: (current: StoredThread | null) => StoredThread | null,
  ): Promise<StoredThread | null>
  // Stores a chat that arrives from elsewhere, such as the cloud, under its
  // own id, even one deleted from this device before. A chat already stored
  // under the id is kept, and null is returned.
  add(thread: StoredThread): Promise<StoredThread | null>
  delete(id: string): Promise<void>
  deleteAll(): Promise<number>
}

// Image bytes travel with the last few user messages that carry them. The
// harness reads older images through their descriptions instead.
export const RECENT_IMAGE_MESSAGES = 3

// Rows the browser writes hold a thread under this marker, which tells them
// from rows the previous client wrote.
const THREAD_FORMAT = 1
// Statuses with which the harness refuses an old row itself, rather than
// the request that carried it.
const REFUSED_ROW_STATUSES = new Set([400, 413])

type Value = Record<string, unknown>
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const obj = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : {}
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T

export const now = () => new Date().toISOString()

export function newThread(
  id: string,
  fields: Pick<StoredThread, 'model' | 'presetId'> & {
    webSearchEnabled?: boolean
  },
): StoredThread {
  const createdAt = now()
  return {
    id,
    title: 'New Chat',
    titleState: 'placeholder',
    createdAt,
    updatedAt: createdAt,
    model: fields.model,
    projectId: null,
    presetId: fields.presetId,
    pinned: false,
    webSearchEnabled: fields.webSearchEnabled ?? true,
    messages: [],
    activeRun: null,
  }
}

// A chat on this device belongs to no project, is no favorite, and has no
// run the harness could report.
export function localSummary(thread: StoredThread): ThreadSummary {
  return summaryOf(thread, thread.messages.length)
}

function summaryOf(
  thread: Omit<StoredThread, 'messages'>,
  messageCount: number,
): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    titleState: thread.titleState,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.model ?? '',
    projectId: null,
    pinned: false,
    webSearchEnabled: thread.webSearchEnabled ?? true,
    messageCount,
    activeRun: null,
    contextUsage: thread.contextUsage ?? null,
  }
}

// The chat as the view shows it, without the image bytes and page images
// its attachments hold.
export function localThreadView(thread: StoredThread): Thread {
  return {
    ...localSummary(thread),
    presetId: thread.presetId ?? null,
    messages: thread.messages.map(({ attachments, ...message }): Message =>
      attachments
        ? {
            ...message,
            attachments: attachments.map(
              ({ base64: _, pages: __, ...shown }) => shown,
            ),
          }
        : message,
    ),
    hasOlder: false,
  }
}

// A reply's text rewritten as the harness rewrites a stored one: its text
// blocks collapse into one holding the new text, where the first was, and
// its reasoning, search and tool blocks stay.
export function replaceReplyText(
  message: ThreadMessage,
  text: string,
): ThreadMessage {
  const timeline = message.timeline ?? []
  let first = timeline.findIndex((block) => block.type === 'content')
  const edited = {
    id: first < 0 ? 'edited-content' : timeline[first].id,
    type: 'content' as const,
    content: text,
  }
  if (first < 0) first = timeline.length
  const blocks: typeof timeline = []
  for (let i = 0; i <= timeline.length; i++) {
    if (i === first && text !== '') blocks.push(edited)
    if (i < timeline.length && timeline[i].type !== 'content')
      blocks.push(timeline[i])
  }
  return { ...message, content: text, timeline: blocks }
}

// A document's text as the harness reads a stored one: its extracted text,
// or else the text of its pages.
export function localDocumentText(attachment: AttachmentDescriptor): string {
  if (attachment.textContent) return attachment.textContent
  return (attachment.pages ?? [])
    .map((page) => page.text)
    .filter(Boolean)
    .join('\n\n')
}

// The images of an attachment the harness may leave out of a thread: an
// image's bytes, and a document's page images by page.
interface HeldImages {
  base64?: string
  pageImages?: string[]
}

export type ImagesById = Map<string, HeldImages>

const carriesBytes = (attachment: AttachmentDescriptor) =>
  !!attachment.base64 || !!attachment.pages?.some((page) => page.image)

function withoutBytes(attachment: AttachmentDescriptor): AttachmentDescriptor {
  const { base64: _, ...rest } = attachment
  return attachment.pages
    ? {
        ...rest,
        pages: attachment.pages.map((page) => ({ ...page, image: '' })),
      }
    : rest
}

// Records the images of attachments, by attachment id.
export function holdImages(
  attachments: readonly AttachmentDescriptor[],
  held: ImagesById = new Map(),
): ImagesById {
  for (const attachment of attachments) {
    if (!carriesBytes(attachment)) continue
    held.set(attachment.id, {
      ...(attachment.base64 ? { base64: attachment.base64 } : {}),
      ...(attachment.pages?.some((page) => page.image)
        ? { pageImages: attachment.pages.map((page) => page.image) }
        : {}),
    })
  }
  return held
}

export function heldImages(messages: readonly ThreadMessage[]): ImagesById {
  const held: ImagesById = new Map()
  for (const message of messages) holdImages(message.attachments ?? [], held)
  return held
}

// Puts back the images the browser holds where a thread lacks them.
export function withHeldImages(
  messages: readonly ThreadMessage[],
  held: ReadonlyMap<string, HeldImages>,
): ThreadMessage[] {
  return messages.map((message) =>
    message.attachments?.some((attachment) => held.has(attachment.id))
      ? {
          ...message,
          attachments: message.attachments.map((attachment) => {
            const kept = held.get(attachment.id)
            if (!kept) return attachment
            const { base64, pageImages } = kept
            return {
              ...attachment,
              ...(base64 && !attachment.base64 ? { base64 } : {}),
              ...(pageImages && attachment.pages
                ? {
                    pages: attachment.pages.map((page, index) =>
                      pageImages[index] && !page.image
                        ? { ...page, image: pageImages[index] }
                        : page,
                    ),
                  }
                : {}),
            }
          }),
        }
      : message,
  )
}

// The copy of a thread a local turn carries. An idle local thread needs it
// on every turn, since the harness keeps nothing once a run ends.
export function turnThread(
  thread: StoredThread,
  recentImageMessages = RECENT_IMAGE_MESSAGES,
): StoredThread {
  const keep = new Set(
    thread.messages
      .flatMap((message, index) =>
        message.role === 'user' && message.attachments?.some(carriesBytes)
          ? [index]
          : [],
      )
      .slice(-recentImageMessages),
  )
  return {
    ...thread,
    messages: thread.messages.map((message, index) =>
      message.attachments && !keep.has(index)
        ? { ...message, attachments: message.attachments.map(withoutBytes) }
        : message,
    ),
  }
}

// The copy of a thread a share carries. A share holds image thumbnails and
// document text, never image bytes or page images; a document whose text is
// only in its pages keeps that text.
export function shareThread(thread: StoredThread): StoredThread {
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      message.attachments
        ? {
            ...message,
            attachments: message.attachments.map((attachment) => {
              const { base64: _, pages: __, ...shared } = attachment
              const text = localDocumentText(attachment)
              return text ? { ...shared, textContent: text } : shared
            }),
          }
        : message,
    ),
  }
}

export function isThread(value: unknown): value is StoredThread {
  return (
    !!value && typeof value === 'object' && Array.isArray(obj(value).messages)
  )
}

async function requestUpgrade(rows: readonly Value[]): Promise<StoredThread[]> {
  const result = await harnessAPI().post<{ threads?: unknown }>(
    '/v1/threads/upgrade',
    { threads: rows },
    undefined,
    false,
  )
  const threads = arr(result?.threads)
  if (threads.length !== rows.length || !threads.every(isThread))
    throw new HarnessError({
      code: 'UPSTREAM_REFUSED',
      message: 'The chat service returned invalid chats.',
    })
  return threads.map((thread, index) => ({
    ...(thread as StoredThread),
    id: str(rows[index].id) || (thread as StoredThread).id,
  }))
}

// Upgrades a batch of rows in one request. A batch the harness refuses for a
// row in it is split, so that only the rows it refuses alone are left out.
async function upgradeBatch(
  rows: readonly Value[],
): Promise<(StoredThread | null)[]> {
  try {
    return await requestUpgrade(rows)
  } catch (cause) {
    if (
      !(cause instanceof HarnessError) ||
      !REFUSED_ROW_STATUSES.has(cause.status ?? 0)
    )
      throw cause
    if (rows.length === 1) return [null]
    const threads: (StoredThread | null)[] = []
    for (const row of rows) threads.push(...(await upgradeBatch([row])))
    return threads
  }
}

// Upgrades chats in the previous client's format, from this device or an
// export or backup, into threads through the harness's reader of old chats,
// in requests no larger than the harness reads. A row it cannot upgrade, as
// one too large to send, is handed back as null.
async function upgradeInBatches(
  rows: AsyncIterable<Value> | Iterable<Value>,
  upgraded: (row: Value, thread: StoredThread | null) => Promise<void>,
) {
  let batch: Value[] = []
  let bytes = 0
  const flush = async () => {
    const sent = batch
    batch = []
    bytes = 0
    if (!sent.length) return
    const threads = await upgradeBatch(sent)
    for (const [index, row] of sent.entries())
      await upgraded(row, threads[index])
  }
  for await (const row of rows) {
    // Each row also takes the comma that separates it from the next.
    const size = requestBytes(row) + 1
    if (size > MAX_TURN_REQUEST_BYTES) {
      await upgraded(row, null)
      continue
    }
    if (bytes + size > MAX_TURN_REQUEST_BYTES) await flush()
    batch.push(row)
    bytes += size
  }
  await flush()
}

export async function upgradeThreads(
  rows: readonly object[],
): Promise<(StoredThread | null)[]> {
  const threads = new Map<Value, StoredThread | null>()
  await upgradeInBatches(rows as Value[], async (row, thread) => {
    threads.set(row, thread)
  })
  return (rows as Value[]).map((row) => threads.get(row) ?? null)
}

// A chat as a row the previous client's storage reads: its messages stay on
// the row, so IndexedDB keeps their attachments' content apart, and the
// rest of the thread is kept with it as it is.
interface ThreadRow {
  id: string
  isLocalOnly: true
  threadFormat: typeof THREAD_FORMAT
  title: string
  createdAt: string
  updatedAt: string
  messages: ThreadMessage[]
  thread: Omit<StoredThread, 'messages'>
}

function rowOf({ messages, ...thread }: StoredThread): ThreadRow {
  return {
    id: thread.id,
    isLocalOnly: true,
    threadFormat: THREAD_FORMAT,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages,
    thread,
  }
}

const isThreadRow = (row: Value) => row.threadFormat === THREAD_FORMAT

// A row read back, without what storage added to its messages.
function threadOf(row: Value): StoredThread {
  return {
    ...(obj(row.thread) as Omit<StoredThread, 'messages'>),
    id: str(row.id),
    messages: arr(row.messages).map((item) => {
      const { timestamp: _, attachments, ...message } = obj(item)
      return defined({
        ...message,
        ...(Array.isArray(attachments)
          ? {
              attachments: attachments.map((value) => {
                const { storagePayloadId: __, ...attachment } = obj(value)
                // An image's payload placeholder.
                if (
                  attachment.kind === 'image' &&
                  attachment.textContent === ''
                )
                  delete attachment.textContent
                return defined(attachment)
              }),
            }
          : {}),
      }) as unknown as ThreadMessage
    }),
  }
}

interface Backend {
  summaries(): Promise<{ row: Value; messageCount: number }[]>
  read(id: string): Promise<Value | null>
  write(thread: StoredThread): Promise<boolean>
  remove(id: string): Promise<void>
  ids(): Promise<string[]>
  removeAll(): Promise<void>
}

const hasPayload = (attachment: AttachmentDescriptor) =>
  attachment.base64 !== undefined ||
  attachment.textContent !== undefined ||
  attachment.pages !== undefined

function indexedDBBackend(storage: IndexedDBStorage): Backend {
  return {
    async summaries() {
      return (await storage.getChatSummaries())
        .filter((row) => row.isLocalOnly === true)
        .map((row) => ({
          row: row as unknown as Value,
          messageCount: row.messageCount ?? 0,
        }))
    },
    async read(id) {
      const row = await storage.getChat(id)
      return row?.isLocalOnly ? (row as unknown as Value) : null
    },
    async write(thread) {
      const row = rowOf(thread)
      const result = await storage.saveChat({
        ...row,
        // Every stored attachment needs some payload for the payload store.
        messages: row.messages.map((message) =>
          message.attachments
            ? {
                ...message,
                attachments: message.attachments.map((attachment) =>
                  hasPayload(attachment)
                    ? attachment
                    : { ...attachment, textContent: '' },
                ),
              }
            : message,
        ),
      } as unknown as StoredChatRow)
      return result.saved
    },
    remove: (id) => storage.deleteChat(id),
    ids: () => storage.getAllChatIds(),
    async removeAll() {
      await storage.deleteAllChats()
    },
  }
}

// A signed-out visitor's chats last as long as the browser tab. Session
// storage cannot hold large images, so an image's bytes and a document's
// page images stay in this page's memory only, by chat and attachment id;
// after a reload the chat keeps the image's thumbnail and the document's
// text.
function sessionBackend(): Backend {
  const images = new Map<string, ImagesById>()
  return {
    async summaries() {
      return sessionChatStorage.getAllChats().map((chat) => ({
        row: chat as unknown as Value,
        messageCount: chat.messages.length,
      }))
    },
    async read(id) {
      const row = sessionChatStorage.getChat(id) as unknown as Value | null
      const kept = images.get(id)
      if (!row) images.delete(id)
      if (!row || !kept || !isThreadRow(row)) return row
      return {
        ...row,
        messages: withHeldImages(arr(row.messages) as ThreadMessage[], kept),
      }
    },
    async write(thread) {
      const kept = heldImages(thread.messages)
      sessionChatStorage.saveChat(
        rowOf({
          ...thread,
          messages: thread.messages.map((message) =>
            message.attachments
              ? {
                  ...message,
                  attachments: message.attachments.map((attachment) =>
                    kept.has(attachment.id)
                      ? withoutBytes(attachment)
                      : attachment,
                  ),
                }
              : message,
          ),
        }) as unknown as Chat,
      )
      if (kept.size) images.set(thread.id, kept)
      else images.delete(thread.id)
      return true
    },
    async remove(id) {
      sessionChatStorage.deleteChat(id)
      images.delete(id)
    },
    async ids() {
      return sessionChatStorage.getAllChats().map((chat) => chat.id)
    },
    async removeAll() {
      sessionChatStorage.clearAll()
      images.clear()
    },
  }
}

function createStore(
  backend: Backend,
  { durable }: { durable: boolean },
): LocalThreadStore {
  const tails = new Map<string, Promise<unknown>>()
  // Durable stores share the deletion tracker, so a run that finishes after
  // its chat was deleted cannot write the chat back.
  const isDeleted = (id: string) => durable && deletedChatsTracker.isDeleted(id)
  const serialize = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(task)
    tails.set(id, run)
    void run
      .finally(() => {
        if (tails.get(id) === run) tails.delete(id)
      })
      .catch(() => {})
    return run
  }
  const emit = (event: Parameters<typeof chatEvents.emit>[0]) => {
    if (durable) chatEvents.emit(event)
  }
  const markDeleted = (ids: string[], deleted: boolean) => {
    if (!durable) return
    for (const id of ids)
      if (deleted) deletedChatsTracker.markAsDeleted(id)
      else deletedChatsTracker.removeLocalDeletion(id)
  }
  // Rows the previous client wrote are rewritten as threads once, before
  // anything reads them. A row the harness cannot upgrade stays as it was
  // and is left out until a later attempt upgrades it.
  let upgrading: Promise<void> | null = null
  const upgradeOldRows = () => {
    upgrading ??= (async () => {
      const ids = (await backend.summaries())
        .filter(({ row }) => !isThreadRow(row))
        .map(({ row }) => str(row.id))
      async function* rows() {
        for (const id of ids) {
          const row = await backend.read(id)
          if (row && !isThreadRow(row)) yield row
        }
      }
      const written: string[] = []
      await upgradeInBatches(rows(), async (row, thread) => {
        const id = str(row.id)
        if (!thread) {
          logError(
            'Failed to upgrade a chat stored on this device',
            undefined,
            {
              component: 'localThreads',
              action: 'upgradeOldRows',
              metadata: { chatId: id },
            },
          )
          return
        }
        const saved = await serialize(id, async () => {
          const current = await backend.read(id)
          if (!current || isThreadRow(current) || isDeleted(id)) return false
          return backend.write({ ...thread, id })
        })
        if (saved) written.push(id)
      })
      if (written.length) emit({ reason: 'save', ids: written })
    })().finally(() => {
      upgrading = null
    })
    return upgrading
  }
  const readThread = async (id: string): Promise<StoredThread | null> => {
    let row = await backend.read(id)
    if (row && !isThreadRow(row)) {
      await upgradeOldRows()
      row = await backend.read(id)
    }
    return row && isThreadRow(row) ? threadOf(row) : null
  }
  return {
    async list() {
      let rows = await backend.summaries()
      if (rows.some(({ row }) => !isThreadRow(row))) {
        await upgradeOldRows()
        rows = await backend.summaries()
      }
      return rows
        .filter(({ row }) => isThreadRow(row) && !isDeleted(str(row.id)))
        .map(({ row, messageCount }) =>
          summaryOf(
            {
              ...(obj(row.thread) as unknown as StoredThread),
              id: str(row.id),
            },
            messageCount,
          ),
        )
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    },
    async get(id) {
      if (isDeleted(id)) return null
      return readThread(id)
    },
    async update(id, change) {
      // An old row is upgraded before the change reads it.
      if (!isDeleted(id)) await readThread(id)
      return serialize(id, async () => {
        if (isDeleted(id)) return null
        const row = await backend.read(id)
        const next = change(row && isThreadRow(row) ? threadOf(row) : null)
        if (!next || isDeleted(id)) return null
        if (!(await backend.write(next))) return null
        emit({ reason: 'save', ids: [id] })
        return next
      })
    },
    add(thread) {
      return serialize(thread.id, async () => {
        if (await backend.read(thread.id)) return null
        markDeleted([thread.id], false)
        if (!(await backend.write(thread))) return null
        emit({ reason: 'save', ids: [thread.id] })
        return thread
      })
    },
    delete(id) {
      return serialize(id, async () => {
        markDeleted([id], true)
        try {
          await backend.remove(id)
        } catch (error) {
          markDeleted([id], false)
          throw error
        }
        emit({ reason: 'delete', ids: [id] })
      })
    },
    async deleteAll() {
      const ids = await backend.ids()
      markDeleted(ids, true)
      try {
        await backend.removeAll()
      } catch (error) {
        markDeleted(ids, false)
        throw error
      }
      emit({ reason: 'delete-all' })
      return ids.length
    },
  }
}

const stores = new Map<'device' | 'tab', LocalThreadStore>()

// Signed-in chats live in the device's IndexedDB; a signed-out visitor's live
// in session storage and never touch IndexedDB.
export function localThreadStore(scope: 'device' | 'tab'): LocalThreadStore {
  let store = stores.get(scope)
  if (!store) {
    store = createStore(
      scope === 'device'
        ? indexedDBBackend(indexedDBStorage)
        : sessionBackend(),
      { durable: true },
    )
    stores.set(scope, store)
  }
  return store
}

// A temporary chat that runs as a local thread keeps its transcript in memory
// only, for as long as it stays open.
export function memoryThreadStore(): LocalThreadStore {
  const threads = new Map<string, ThreadRow>()
  return createStore(
    {
      async summaries() {
        return []
      },
      async read(id) {
        const row = threads.get(id)
        return row ? (structuredClone(row) as unknown as Value) : null
      },
      async write(thread) {
        threads.set(thread.id, structuredClone(rowOf(thread)))
        return true
      },
      async remove(id) {
        threads.delete(id)
      },
      async ids() {
        return [...threads.keys()]
      },
      async removeAll() {
        threads.clear()
      },
    },
    { durable: false },
  )
}
