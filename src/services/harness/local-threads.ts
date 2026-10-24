import type { Chat } from '@/components/chat/types'
import { PLACEHOLDER_CHAT_TITLE } from '@/constants/chat'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  indexedDBStorage,
  type AttachmentOriginal,
  type IndexedDBStorage,
  type Chat as StoredChatRow,
} from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { logError } from '@/utils/error-handling'
import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import { harnessAPI } from './runtime'
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

// The files a user picked for image attachments, by attachment id. A thread
// holds the copy models read; the originals are only shown and downloaded,
// and never sent with a turn.
export type Originals = ReadonlyMap<string, AttachmentOriginal>

export interface LocalThreadStore {
  list(): Promise<ThreadSummary[]>
  get(id: string): Promise<StoredThread | null>
  // Reads, changes, and writes one thread at a time, so concurrent runs of
  // the same chat cannot lose each other's messages. Returning null skips
  // the write, as does a chat deleted in the meantime. Originals of the
  // written thread's attachments are kept with it.
  update(
    id: string,
    change: (current: StoredThread | null) => StoredThread | null,
    originals?: Originals,
  ): Promise<StoredThread | null>
  // Stores a chat that arrives from elsewhere, such as the cloud, under its
  // own id, even one deleted from this device before. A chat already stored
  // under the id is kept, and null is returned.
  add(thread: StoredThread, originals?: Originals): Promise<StoredThread | null>
  originals(id: string, attachmentIds: readonly string[]): Promise<Originals>
  delete(id: string): Promise<void>
  deleteAll(): Promise<number>
}

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

// The copy of a new chat this device lists until the harness returns the
// chat its first turn made.
export function newThread(id: string): StoredThread {
  const createdAt = now()
  return {
    id,
    title: PLACEHOLDER_CHAT_TITLE,
    titleState: 'placeholder',
    createdAt,
    updatedAt: createdAt,
    model: '',
    projectId: null,
    presetId: null,
    pinned: false,
    webSearchEnabled: true,
    messages: [],
    activeRun: null,
  }
}

// A chat on this device belongs to no project, is no favorite, and has no
// run the harness could report.
export function localSummary(thread: StoredThread): ThreadSummary {
  return summaryOf(
    { ...thread, activityAt: activityAt(thread.createdAt, thread.messages) },
    thread.messages.length,
  )
}

function activityAt(
  createdAt: string | undefined,
  messages: readonly ThreadMessage[],
): string {
  let latest = Date.parse(createdAt ?? '') || 0
  for (const message of messages) {
    const time = Date.parse(message.createdAt)
    if (time > latest) latest = time
  }
  return new Date(latest).toISOString()
}

function summaryOf(
  thread: Omit<StoredThread, 'messages'> & { activityAt?: string },
  messageCount: number,
): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    titleState: thread.titleState,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    activityAt: thread.activityAt ?? thread.createdAt ?? '',
    model: thread.model ?? '',
    projectId: null,
    pinned: false,
    webSearchEnabled: thread.webSearchEnabled ?? true,
    messageCount,
    activeRun: null,
    contextUsage: thread.contextUsage ?? null,
    ...(thread.flagged ? { flagged: true } : {}),
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

// Upgrades a chat this device stored in the previous client's format into a
// thread through the harness's reader of old chats, one chat per request. A chat the harness refuses, as one too large to
// send, is handed back as null.
async function upgradeRow(row: Value): Promise<StoredThread | null> {
  let result: { threads?: unknown }
  try {
    result = await harnessAPI().post<{ threads?: unknown }>(
      ROUTES.upgrade,
      { threads: [row] },
      { keyless: true },
    )
  } catch (cause) {
    if (
      cause instanceof HarnessError &&
      REFUSED_ROW_STATUSES.has(cause.status ?? 0)
    )
      return null
    throw cause
  }
  const [thread, ...rest] = arr(result?.threads)
  if (rest.length || !isThread(thread))
    throw new HarnessError({
      code: ERROR_CODES.upstreamRefused,
      action: ERROR_ACTIONS.retry,
      message: 'The chat service returned an invalid chat.',
    })
  return { ...thread, id: str(row.id) || thread.id }
}

// The images of an old row, as the originals of the image attachments the
// harness upgraded them into; the upgraded thread holds the copy models
// read. An attachment keeps its id, and an image the row kept on its message
// is matched in order to the message's upgraded images.
function legacyOriginals(row: Value, thread: StoredThread): Originals {
  const originals = new Map<string, AttachmentOriginal>()
  arr(row.messages).forEach((item, index) => {
    const message = obj(item)
    const images = (thread.messages[index]?.attachments ?? []).filter(
      (attachment) => attachment.kind === 'image',
    )
    const keep = (attachment: AttachmentDescriptor | undefined, old: Value) => {
      const base64 = str(old.base64)
      if (attachment && base64)
        originals.set(attachment.id, {
          base64,
          mimeType: str(old.mimeType) || attachment.mimeType,
        })
    }
    const listed = arr(message.attachments).map(obj)
    if (listed.length) {
      for (const old of listed)
        keep(
          images.find((image) => image.id === str(old.id)),
          old,
        )
      return
    }
    const kept = arr(message.imageData)
      .map(obj)
      .filter((old) => str(old.base64))
    if (kept.length === images.length)
      kept.forEach((old, at) => keep(images[at], old))
  })
  return originals
}

// A chat as a row the previous client's storage reads: its messages stay on
// the row, so IndexedDB keeps their attachments' content apart, and the
// rest of the thread is kept with it as it is.
interface ThreadRow {
  activityAt: string
  id: string
  isLocalOnly: true
  threadFormat: typeof THREAD_FORMAT
  title: string
  createdAt?: string
  updatedAt?: string
  messages: ThreadMessage[]
  thread: Omit<StoredThread, 'messages'>
}

function rowOf({ messages, ...thread }: StoredThread): ThreadRow {
  return {
    activityAt: activityAt(thread.createdAt, messages),
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
      }) as ThreadMessage
    }),
  }
}

interface Backend {
  summaries(): Promise<{ row: Value; messageCount: number }[]>
  read(id: string): Promise<Value | null>
  write(thread: StoredThread, originals: Originals): Promise<boolean>
  originals(id: string, attachmentIds: readonly string[]): Promise<Originals>
  remove(id: string): Promise<void>
  ids(): Promise<string[]>
  removeAll(): Promise<void>
}

const attachmentIdsOf = (thread: StoredThread) =>
  thread.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) => attachment.id),
  )

// Originals kept in this page's memory only, by chat and attachment id.
function pageOriginals() {
  const chats = new Map<string, Map<string, AttachmentOriginal>>()
  return {
    write(thread: StoredThread, originals: Originals) {
      const previous = chats.get(thread.id)
      const kept = new Map<string, AttachmentOriginal>()
      for (const id of attachmentIdsOf(thread)) {
        const original = originals.get(id) ?? previous?.get(id)
        if (original) kept.set(id, original)
      }
      if (kept.size) chats.set(thread.id, kept)
      else chats.delete(thread.id)
    },
    async get(id: string, attachmentIds: readonly string[]) {
      const kept = chats.get(id)
      const found = new Map<string, AttachmentOriginal>()
      for (const attachmentId of attachmentIds) {
        const original = kept?.get(attachmentId)
        if (original) found.set(attachmentId, original)
      }
      return found
    },
    remove: (id: string) => chats.delete(id),
    clear: () => chats.clear(),
  }
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
          row: obj(row),
          messageCount: row.messageCount ?? 0,
        }))
    },
    async read(id) {
      const row = await storage.getChat(id)
      return row?.isLocalOnly ? obj(row) : null
    },
    async write(thread, originals) {
      const row = rowOf(thread)
      const result = await storage.saveChat(
        {
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
        } as unknown as StoredChatRow,
        originals,
      )
      return result.saved
    },
    originals: (id, attachmentIds) =>
      storage.getAttachmentOriginals(id, attachmentIds),
    remove: (id) => storage.deleteChat(id),
    ids: () => storage.getAllChatIds(),
    async removeAll() {
      await storage.deleteAllChats()
    },
  }
}

// A signed-out visitor's chats last as long as the browser tab. Session
// storage cannot hold large images, so an image's bytes, its original and a
// document's page images stay in this page's memory only, by chat and
// attachment id; after a reload the chat keeps the image's thumbnail and the
// document's text.
function sessionBackend(): Backend {
  const images = new Map<string, ImagesById>()
  const originals = pageOriginals()
  return {
    async summaries() {
      return sessionChatStorage.getAllChats().map((chat) => ({
        row: obj(chat),
        messageCount: chat.messages.length,
      }))
    },
    async read(id) {
      const chat = sessionChatStorage.getChat(id)
      const row = chat && obj(chat)
      const kept = images.get(id)
      if (!row) images.delete(id)
      if (!row || !kept || !isThreadRow(row)) return row
      return {
        ...row,
        messages: withHeldImages(arr(row.messages) as ThreadMessage[], kept),
      }
    },
    async write(thread, picked) {
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
      originals.write(thread, picked)
      return true
    },
    originals: originals.get,
    async remove(id) {
      sessionChatStorage.deleteChat(id)
      images.delete(id)
      originals.remove(id)
    },
    async ids() {
      return sessionChatStorage.getAllChats().map((chat) => chat.id)
    },
    async removeAll() {
      sessionChatStorage.clearAll()
      images.clear()
      originals.clear()
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
      else deletedChatsTracker.removeDeletion(id)
  }
  // Rows the previous client wrote are rewritten as threads once, before
  // anything reads them. A row the harness cannot upgrade, or fails to, stays
  // as it was and is left out until a later attempt upgrades it.
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
      for await (const row of rows()) {
        const id = str(row.id)
        let thread: StoredThread | null = null
        let failure: unknown
        try {
          thread = await upgradeRow(row)
        } catch (cause) {
          failure = cause
        }
        if (!thread) {
          logError('Failed to upgrade a chat stored on this device', failure, {
            component: 'localThreads',
            action: 'upgradeOldRows',
            metadata: { chatId: id },
          })
          continue
        }
        const saved = await serialize(id, async () => {
          const current = await backend.read(id)
          if (!current || isThreadRow(current) || isDeleted(id)) return false
          return backend.write({ ...thread, id }, legacyOriginals(row, thread))
        })
        if (saved) written.push(id)
      }
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
              ...(obj(row.thread) as Omit<StoredThread, 'messages'>),
              id: str(row.id),
              activityAt: str(row.activityAt) || undefined,
            },
            messageCount,
          ),
        )
        .sort((a, b) => Date.parse(b.activityAt!) - Date.parse(a.activityAt!))
    },
    async get(id) {
      if (isDeleted(id)) return null
      return readThread(id)
    },
    async update(id, change, originals = new Map()) {
      // An old row is upgraded before the change reads it.
      if (!isDeleted(id)) await readThread(id)
      return serialize(id, async () => {
        if (isDeleted(id)) return null
        const row = await backend.read(id)
        const next = change(row && isThreadRow(row) ? threadOf(row) : null)
        if (!next || isDeleted(id)) return null
        if (!(await backend.write(next, originals))) return null
        emit({ reason: 'save', ids: [id] })
        return next
      })
    },
    add(thread, originals = new Map()) {
      return serialize(thread.id, async () => {
        if (await backend.read(thread.id)) return null
        markDeleted([thread.id], false)
        if (!(await backend.write(thread, originals))) return null
        emit({ reason: 'save', ids: [thread.id] })
        return thread
      })
    },
    async originals(id, attachmentIds) {
      if (isDeleted(id)) return new Map()
      return backend.originals(id, attachmentIds)
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
  const originals = pageOriginals()
  return createStore(
    {
      async summaries() {
        return []
      },
      async read(id) {
        const row = threads.get(id)
        return row ? obj(structuredClone(row)) : null
      },
      async write(thread, picked) {
        threads.set(thread.id, structuredClone(rowOf(thread)))
        originals.write(thread, picked)
        return true
      },
      originals: originals.get,
      async remove(id) {
        threads.delete(id)
        originals.remove(id)
      },
      async ids() {
        return [...threads.keys()]
      },
      async removeAll() {
        threads.clear()
        originals.clear()
      },
    },
    { durable: false },
  )
}
