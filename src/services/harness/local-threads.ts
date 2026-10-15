import type { Chat, DocumentPage, Message } from '@/components/chat/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  indexedDBStorage,
  type IndexedDBStorage,
  type Chat as StoredChatRow,
} from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { isoTime, upgradeMessages } from './legacy'
import type {
  Json,
  Thread,
  ThreadSummary,
  TimelineBlock,
  Attachment as WireAttachment,
  Message as WireMessage,
} from './types'

// A chat kept on this device. Messages use the harness's stored format, so a
// turn can send them back as the thread's transcript. Attachments keep their
// full descriptors, including image bytes, which the harness never stores for
// a local thread.
export interface LocalAttachment {
  id: string
  type: 'image' | 'document'
  kind?: string
  fileName: string
  mimeType?: string
  fileSize?: number
  thumbnailBase64?: string
  textContent?: string
  description?: string
  pages?: DocumentPage[]
  base64?: string
}

export interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  content: string
  quote?: string
  model?: string
  modelDisplayName?: string
  usage?: Json
  timeline?: TimelineBlock[]
  attachments?: LocalAttachment[]
  isError?: boolean
  isInterrupted?: boolean
}

export interface LocalThread {
  id: string
  title: string
  titleState: ThreadSummary['titleState']
  createdAt: string
  updatedAt: string
  model?: string
  presetId?: string
  webSearchEnabled?: boolean
  codeExecutionAccessToken?: string
  contextUsage?: ThreadSummary['contextUsage']
  messages: LocalMessage[]
}

export type LocalTurnThread = Omit<
  LocalThread,
  'id' | 'updatedAt' | 'contextUsage' | 'presetId'
> & { presetId: string | null }

export interface LocalThreadStore {
  list(): Promise<ThreadSummary[]>
  get(id: string): Promise<LocalThread | null>
  // Reads, changes, and writes one thread at a time, so concurrent runs of
  // the same chat cannot lose each other's messages. Returning null skips
  // the write, as does a chat deleted in the meantime.
  update(
    id: string,
    change: (current: LocalThread | null) => LocalThread | null,
  ): Promise<LocalThread | null>
  // Stores a chat that arrives from elsewhere, such as the cloud, under its
  // own id, even one deleted from this device before. A chat already stored
  // under the id is kept, and null is returned.
  add(thread: LocalThread): Promise<LocalThread | null>
  delete(id: string): Promise<void>
  deleteAll(): Promise<number>
}

// Image bytes travel with the last few user messages that carry them. The
// harness reads older images through their descriptions instead.
export const RECENT_IMAGE_MESSAGES = 3

type Value = Record<string, unknown>
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const obj = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : {}
const isTitleState = (value: unknown): value is LocalThread['titleState'] =>
  value === 'placeholder' || value === 'generated' || value === 'manual'

function contextUsage(value: unknown): LocalThread['contextUsage'] {
  const usage = obj(value)
  return typeof usage.usedTokens === 'number' &&
    typeof usage.limitTokens === 'number' &&
    typeof usage.percentage === 'number'
    ? {
        usedTokens: usage.usedTokens,
        limitTokens: usage.limitTokens,
        percentage: usage.percentage,
      }
    : undefined
}

function readAttachment(value: Value): LocalAttachment {
  const kind = str(value.kind)
  return {
    id: str(value.id),
    type: (kind || str(value.type)) === 'image' ? 'image' : 'document',
    ...(kind ? { kind } : {}),
    fileName: str(value.fileName) || 'Attachment',
    ...(str(value.mimeType) ? { mimeType: str(value.mimeType) } : {}),
    ...(typeof value.fileSize === 'number' ? { fileSize: value.fileSize } : {}),
    ...(str(value.thumbnailBase64)
      ? { thumbnailBase64: str(value.thumbnailBase64) }
      : {}),
    ...(typeof value.textContent === 'string'
      ? { textContent: value.textContent }
      : {}),
    ...(str(value.description) ? { description: str(value.description) } : {}),
    ...(Array.isArray(value.pages)
      ? { pages: value.pages as DocumentPage[] }
      : {}),
    ...(str(value.base64) ? { base64: str(value.base64) } : {}),
  }
}

// An upload's stored descriptor, with the image bytes the browser keeps.
export function localAttachment(
  descriptor: unknown,
  base64?: string,
): LocalAttachment {
  return { ...readAttachment(obj(descriptor)), ...(base64 ? { base64 } : {}) }
}

function readMessage(value: Value): LocalMessage {
  const role = value.role === 'assistant' ? 'assistant' : 'user'
  const attachments = arr(value.attachments).map((item) =>
    readAttachment(obj(item)),
  )
  return {
    id: str(value.id),
    role,
    createdAt: str(value.createdAt),
    content: str(value.content),
    ...(str(value.quote) ? { quote: str(value.quote) } : {}),
    ...(str(value.model) ? { model: str(value.model) } : {}),
    ...(str(value.modelDisplayName)
      ? { modelDisplayName: str(value.modelDisplayName) }
      : {}),
    ...(value.usage !== undefined && value.usage !== null
      ? { usage: value.usage as Json }
      : {}),
    ...(role === 'assistant'
      ? { timeline: arr(value.timeline) as TimelineBlock[] }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(value.isError === true ? { isError: true } : {}),
    ...(value.isInterrupted === true ? { isInterrupted: true } : {}),
  }
}

// Rows written by the previous client use its message format; they are
// upgraded the way the harness upgrades a local transcript.
export function readLocalThread(row: Value): LocalThread {
  const id = str(row.id)
  const createdAt = isoTime(row.createdAt) || isoTime(row.updatedAt) || now()
  const title = str(row.title) || 'New Chat'
  const usage = contextUsage(row.contextUsage)
  return {
    id,
    title,
    titleState: isTitleState(row.titleState)
      ? row.titleState
      : title === 'New Chat'
        ? 'placeholder'
        : 'generated',
    createdAt,
    updatedAt: isoTime(row.updatedAt) || createdAt,
    ...(str(row.model) ? { model: str(row.model) } : {}),
    ...(str(row.presetId) ? { presetId: str(row.presetId) } : {}),
    ...(typeof row.webSearchEnabled === 'boolean'
      ? { webSearchEnabled: row.webSearchEnabled }
      : {}),
    ...(str(row.codeExecutionAccessToken)
      ? { codeExecutionAccessToken: str(row.codeExecutionAccessToken) }
      : {}),
    ...(usage ? { contextUsage: usage } : {}),
    messages: upgradeMessages(id, row.createdAt, arr(row.messages))
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .map(readMessage),
  }
}

function summaryOf(row: Value, messageCount: number): ThreadSummary {
  const thread = readLocalThread({ ...row, messages: [] })
  return { ...localSummary(thread), messageCount }
}

export function localSummary(thread: LocalThread): ThreadSummary {
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
    messageCount: thread.messages.length,
    activeRun: null,
    contextUsage: thread.contextUsage ?? null,
  }
}

// A reply's text rewritten as the harness rewrites a stored one: its text
// blocks collapse into one holding the new text, where the first was, and
// its reasoning, search and tool blocks stay.
export function replaceReplyText(
  message: LocalMessage,
  text: string,
): LocalMessage {
  const timeline = message.timeline ?? []
  let first = timeline.findIndex((block) => block.type === 'content')
  const edited: TimelineBlock = {
    id: first < 0 ? 'edited-content' : timeline[first].id,
    type: 'content',
    content: text,
  }
  if (first < 0) first = timeline.length
  const blocks: TimelineBlock[] = []
  for (let i = 0; i <= timeline.length; i++) {
    if (i === first && text !== '') blocks.push(edited)
    if (i < timeline.length && timeline[i].type !== 'content')
      blocks.push(timeline[i])
  }
  return { ...message, content: text, timeline: blocks }
}

// A document's text as the harness reads a stored one: its extracted text,
// or else the text of its pages.
export function localDocumentText(attachment: LocalAttachment): string {
  if (attachment.textContent) return attachment.textContent
  return (attachment.pages ?? [])
    .map((page) => page.text)
    .filter(Boolean)
    .join('\n\n')
}

// The harness's publicAttachment: what a client sees of a stored descriptor.
export function wireAttachment(attachment: LocalAttachment): WireAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind || attachment.type,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType ?? '',
    size: attachment.fileSize ?? 0,
    thumbnail: attachment.thumbnailBase64 ?? null,
    pages: attachment.pages?.length ? attachment.pages.length : null,
    status: 'ready',
    ...(attachment.textContent ? { textContent: attachment.textContent } : {}),
    ...(attachment.description ? { description: attachment.description } : {}),
  }
}

// The harness's publicMessage.
export function wireMessage(message: LocalMessage): WireMessage {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    ...(message.quote !== undefined ? { quote: message.quote } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
    ...(message.modelDisplayName !== undefined
      ? { modelDisplayName: message.modelDisplayName }
      : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
    ...(message.isInterrupted !== undefined
      ? { isInterrupted: message.isInterrupted }
      : {}),
    ...(message.usage !== undefined ? { usage: message.usage } : {}),
    ...(message.role === 'assistant'
      ? { timeline: message.timeline ?? [] }
      : { content: message.content }),
    ...(message.attachments?.length
      ? { attachments: message.attachments.map(wireAttachment) }
      : {}),
  }
}

export function localThreadView(thread: LocalThread): Thread {
  return {
    ...localSummary(thread),
    presetId: thread.presetId ?? null,
    messages: thread.messages.map(wireMessage),
    hasOlder: false,
  }
}

// Timestamps take the form the harness gives them, so a stored thread reads
// back unchanged.
export const now = () => isoTime(new Date())

function codeExecutionAccessToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function newLocalThread(
  id: string,
  fields: Pick<LocalThread, 'model' | 'presetId' | 'webSearchEnabled'>,
  createdAt = now(),
): LocalThread {
  return {
    id,
    title: 'New Chat',
    titleState: 'placeholder',
    createdAt,
    updatedAt: createdAt,
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.presetId ? { presetId: fields.presetId } : {}),
    ...(fields.webSearchEnabled !== undefined
      ? { webSearchEnabled: fields.webSearchEnabled }
      : {}),
    codeExecutionAccessToken: codeExecutionAccessToken(),
    messages: [],
  }
}

const carriesBytes = (attachment: LocalAttachment) =>
  !!attachment.base64 || !!attachment.pages?.some((page) => page.image)

function withoutBytes(attachment: LocalAttachment): LocalAttachment {
  const { base64: _, ...rest } = attachment
  return attachment.pages
    ? {
        ...rest,
        pages: attachment.pages.map((page) => ({ ...page, image: '' })),
      }
    : rest
}

// The copy of a thread a local turn carries. An idle local thread needs it
// on every turn, since the harness releases the thread after each run.
export function turnThread(
  thread: LocalThread,
  recentImageMessages = RECENT_IMAGE_MESSAGES,
): LocalTurnThread {
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
    title: thread.title,
    titleState: thread.titleState,
    createdAt: thread.createdAt,
    ...(thread.model ? { model: thread.model } : {}),
    presetId: thread.presetId ?? null,
    ...(thread.webSearchEnabled !== undefined
      ? { webSearchEnabled: thread.webSearchEnabled }
      : {}),
    ...(thread.codeExecutionAccessToken
      ? { codeExecutionAccessToken: thread.codeExecutionAccessToken }
      : {}),
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
export function shareThread(thread: LocalThread): LocalTurnThread {
  return {
    ...turnThread(thread),
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

export interface CommittedReply {
  id: string
  model?: string
  modelDisplayName?: string
  usage?: Json
  isError?: boolean
  isInterrupted?: boolean
}

// RUN_FINISHED and RUN_ERROR describe what a run committed to each reply.
export function committedReplies(metadata: unknown): CommittedReply[] {
  return arr(obj(metadata).messages).flatMap((item) => {
    const reply = obj(item)
    if (!str(reply.id)) return []
    return [
      {
        id: str(reply.id),
        ...(typeof reply.model === 'string' ? { model: reply.model } : {}),
        ...(typeof reply.modelDisplayName === 'string'
          ? { modelDisplayName: reply.modelDisplayName }
          : {}),
        ...(reply.usage !== undefined && reply.usage !== null
          ? { usage: reply.usage as Json }
          : {}),
        ...(typeof reply.isError === 'boolean'
          ? { isError: reply.isError }
          : {}),
        ...(typeof reply.isInterrupted === 'boolean'
          ? { isInterrupted: reply.isInterrupted }
          : {}),
      },
    ]
  })
}

function descriptorOf(view: WireAttachment): LocalAttachment {
  const type = view.kind === 'image' ? 'image' : 'document'
  return {
    id: view.id,
    type,
    ...(view.kind && view.kind !== type ? { kind: view.kind } : {}),
    fileName: view.fileName,
    ...(view.mimeType ? { mimeType: view.mimeType } : {}),
    ...(typeof view.size === 'number' ? { fileSize: view.size } : {}),
    ...(view.thumbnail ? { thumbnailBase64: view.thumbnail } : {}),
    ...(view.textContent ? { textContent: view.textContent } : {}),
  }
}

function contentOf(timeline: TimelineBlock[] | undefined): string {
  return (timeline ?? [])
    .filter((block) => block.type === 'content')
    .map((block) => block.content ?? '')
    .join('')
}

function storedMessage(
  message: WireMessage,
  previous: LocalMessage | undefined,
  descriptors: ReadonlyMap<string, LocalAttachment>,
  reply: CommittedReply | undefined,
  updatedAt: string,
): LocalMessage {
  const timeline = message.timeline ?? previous?.timeline
  const quote = message.quote !== undefined ? message.quote : previous?.quote
  const attachments = message.attachments?.map((view) => ({
    ...(descriptors.get(view.id) ?? descriptorOf(view)),
    ...(view.description ? { description: view.description } : {}),
  }))
  const pick = <K extends keyof CommittedReply>(key: K) =>
    reply?.[key] ?? message[key as keyof WireMessage] ?? previous?.[key]
  const model = pick('model')
  const modelDisplayName = pick('modelDisplayName')
  const usage = pick('usage')
  const isError = pick('isError')
  const isInterrupted = pick('isInterrupted')
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt || previous?.createdAt || updatedAt,
    content:
      message.role === 'assistant'
        ? contentOf(timeline) || previous?.content || ''
        : (message.content ?? previous?.content ?? ''),
    ...(typeof quote === 'string' && quote ? { quote } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof modelDisplayName === 'string' ? { modelDisplayName } : {}),
    ...(usage !== undefined ? { usage: usage as Json } : {}),
    ...(message.role === 'assistant' ? { timeline: timeline ?? [] } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(isError === true ? { isError } : {}),
    ...(isInterrupted === true ? { isInterrupted } : {}),
  }
}

export interface RunWindow {
  messages: WireMessage[]
  hasOlder: boolean
}

// Merges what the harness reports for a run into the stored transcript:
// stored messages before the first message of the window are kept, the
// window replaces the rest, and attachment views map back to the stored
// descriptors (or the descriptors of this run's uploads).
export function mergeLocalThread(
  stored: LocalThread,
  window: RunWindow,
  {
    uploads = new Map(),
    replies = [],
    summary,
    updatedAt = now(),
  }: {
    uploads?: ReadonlyMap<string, LocalAttachment>
    replies?: CommittedReply[]
    summary?: ThreadSummary | null
    updatedAt?: string
  } = {},
): LocalThread {
  const first = window.messages[0]?.id
  const index =
    first === undefined
      ? stored.messages.length
      : stored.messages.findIndex((message) => message.id === first)
  const windowIds = new Set(window.messages.map((message) => message.id))
  const prefix =
    index >= 0
      ? stored.messages.slice(0, index)
      : window.hasOlder
        ? stored.messages.filter((message) => !windowIds.has(message.id))
        : []
  const previous = new Map(
    stored.messages.map((message) => [message.id, message]),
  )
  const descriptors = new Map<string, LocalAttachment>()
  for (const message of stored.messages)
    for (const attachment of message.attachments ?? [])
      descriptors.set(attachment.id, attachment)
  for (const [id, attachment] of uploads) descriptors.set(id, attachment)
  const committed = new Map(replies.map((reply) => [reply.id, reply]))
  // A title the user set while the run streamed outranks the run's title.
  const title =
    summary && stored.titleState !== 'manual'
      ? { title: summary.title, titleState: summary.titleState }
      : {}
  const usage = summary
    ? contextUsage(summary.contextUsage)
    : stored.contextUsage
  const { contextUsage: _, ...rest } = stored
  return {
    ...rest,
    ...title,
    ...(summary?.model ? { model: summary.model } : {}),
    ...(summary && typeof summary.webSearchEnabled === 'boolean'
      ? { webSearchEnabled: summary.webSearchEnabled }
      : {}),
    ...(usage ? { contextUsage: usage } : {}),
    updatedAt,
    messages: [
      ...prefix,
      ...window.messages.map((message) =>
        storedMessage(
          message,
          previous.get(message.id),
          descriptors,
          committed.get(message.id),
          updatedAt,
        ),
      ),
    ],
  }
}

interface Backend {
  summaries(): Promise<{ row: Value; messageCount: number }[]>
  read(id: string): Promise<Value | null>
  write(thread: LocalThread): Promise<boolean>
  remove(id: string): Promise<void>
  ids(): Promise<string[]>
  removeAll(): Promise<void>
}

const hasPayload = (attachment: LocalAttachment) =>
  attachment.base64 !== undefined ||
  attachment.thumbnailBase64 !== undefined ||
  attachment.textContent !== undefined ||
  attachment.pages !== undefined

// The row shape the previous client wrote, so it can still read local chats.
function chatRow(thread: LocalThread): Omit<StoredChatRow, 'createdAt'> {
  return {
    ...thread,
    isLocalOnly: true,
    messages: thread.messages.map((message) => ({
      ...message,
      timestamp: message.createdAt,
      // Every stored attachment needs some payload for the payload store.
      attachments: message.attachments?.map((attachment) =>
        hasPayload(attachment)
          ? attachment
          : { ...attachment, textContent: '' },
      ),
    })) as unknown as Message[],
  }
}

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
      const result = await storage.saveChat({
        ...chatRow(thread),
        createdAt: thread.createdAt,
      })
      return result.saved
    },
    remove: (id) => storage.deleteChat(id),
    ids: () => storage.getAllChatIds(),
    async removeAll() {
      await storage.deleteAllChats()
    },
  }
}

// A signed-out visitor's chats last as long as the browser tab.
function sessionBackend(): Backend {
  return {
    async summaries() {
      return sessionChatStorage.getAllChats().map((chat) => ({
        row: chat as unknown as Value,
        messageCount: chat.messages.length,
      }))
    },
    async read(id) {
      return sessionChatStorage.getChat(id) as unknown as Value | null
    },
    async write(thread) {
      sessionChatStorage.saveChat({
        ...chatRow(thread),
        createdAt: new Date(thread.createdAt),
      } as Chat)
      return true
    },
    async remove(id) {
      sessionChatStorage.deleteChat(id)
    },
    async ids() {
      return sessionChatStorage.getAllChats().map((chat) => chat.id)
    },
    async removeAll() {
      sessionChatStorage.clearAll()
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
  return {
    async list() {
      return (await backend.summaries())
        .filter(({ row }) => !isDeleted(str(row.id)))
        .map(({ row, messageCount }) => summaryOf(row, messageCount))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    },
    async get(id) {
      if (isDeleted(id)) return null
      const row = await backend.read(id)
      return row ? readLocalThread(row) : null
    },
    update(id, change) {
      return serialize(id, async () => {
        if (isDeleted(id)) return null
        const row = await backend.read(id)
        const next = change(row ? readLocalThread(row) : null)
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
  const threads = new Map<string, LocalThread>()
  return createStore(
    {
      async summaries() {
        return []
      },
      async read(id) {
        const thread = threads.get(id)
        return thread ? (structuredClone(thread) as unknown as Value) : null
      },
      async write(thread) {
        threads.set(thread.id, structuredClone(thread))
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
