import type { Attachment, Chat, Message } from '@/components/chat/types'
import {
  localThreadStore,
  type LocalAttachment,
  type LocalThread,
} from '@/services/harness/local-threads'
import type { HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { cloudTranscript } from '@/services/harness/transfer'
import type {
  Thread,
  ThreadSummary,
  Message as WireMessage,
  TimelineBlock as WireTimelineBlock,
} from '@/services/harness/types'
import { attachmentView } from '@/services/harness/view-model'
import { base64ToUint8Array } from '@/utils/binary-codec'
import { logWarning } from '@/utils/error-handling'
import type { AttachmentBytesFetcher } from './export-archive'

// Chats are read for an export a few at a time.
const CLOUD_READ_CONCURRENCY = 4

export interface ChatExportSource {
  chats: Chat[]
  fetchAttachmentBytes: AttachmentBytesFetcher
}

type Block = Pick<WireTimelineBlock, 'type' | 'content'>

function exportedTime(...values: (string | undefined)[]): Date {
  for (const value of values) {
    const date = value ? new Date(value) : null
    if (date && !Number.isNaN(date.getTime())) return date
  }
  return new Date(0)
}

const textOf = (timeline: Block[] | undefined, type: Block['type']) =>
  (timeline ?? [])
    .filter((block) => block.type === type)
    .map((block) => block.content ?? '')
    .join('')

// A reply's reasoning, as the previous client derived it from the reply's
// thinking blocks.
function thoughtsOf(timeline: Block[] | undefined): string | undefined {
  return timeline?.some((block) => block.type === 'thinking')
    ? textOf(timeline, 'thinking')
    : undefined
}

function exportedMessage(
  message: {
    role: Message['role']
    content?: string
    createdAt: string
    timeline?: Block[]
  },
  attachments: Attachment[] | undefined,
  fallbackTime: string,
): Message {
  const thoughts =
    message.role === 'assistant' ? thoughtsOf(message.timeline) : undefined
  return {
    role: message.role,
    content:
      message.role === 'assistant'
        ? message.content || textOf(message.timeline, 'content')
        : (message.content ?? ''),
    timestamp: exportedTime(message.createdAt, fallbackTime),
    ...(thoughts !== undefined ? { thoughts } : {}),
    ...(attachments?.length ? { attachments } : {}),
  } as Message
}

// An attachment as the export reads it. A document's page images are never
// exported, so they are not held while the export is prepared.
function exportedAttachment(
  attachment: LocalAttachment,
  keepImageBytes: boolean,
): Attachment {
  return {
    id: attachment.id,
    type: attachment.type,
    fileName: attachment.fileName,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.fileSize !== undefined
      ? { fileSize: attachment.fileSize }
      : {}),
    ...(keepImageBytes && attachment.base64
      ? { base64: attachment.base64 }
      : {}),
    ...(attachment.textContent !== undefined
      ? { textContent: attachment.textContent }
      : {}),
    ...(attachment.pages
      ? { pages: attachment.pages.map((page) => ({ ...page, image: '' })) }
      : {}),
  }
}

// A chat kept on this device, or a stored chat's transcript, in the shape
// the export writes.
function exportedChat(
  thread: LocalThread,
  fields: Pick<Chat, 'isLocalOnly' | 'projectId'>,
  heldImages?: Map<Attachment, Uint8Array>,
): Chat {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: exportedTime(thread.createdAt, thread.updatedAt),
    updatedAt: exportedTime(thread.updatedAt, thread.createdAt).toISOString(),
    ...fields,
    messages: thread.messages.map((message) =>
      exportedMessage(
        message,
        message.attachments?.map((attachment) => {
          const exported = exportedAttachment(attachment, !heldImages)
          // A transcript's image bytes are decoded once and handed to the
          // archive, rather than kept as text with every other chat's.
          if (heldImages && attachment.type === 'image' && attachment.base64)
            heldImages.set(exported, base64ToUint8Array(attachment.base64))
          return exported
        }),
        thread.createdAt,
      ),
    ),
  }
}

// A stored chat read through its messages, whose attachments are fetched
// while the export is written.
function storedChat(summary: ThreadSummary, messages: WireMessage[]): Chat {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: exportedTime(summary.createdAt, summary.updatedAt),
    updatedAt: exportedTime(summary.updatedAt, summary.createdAt).toISOString(),
    isLocalOnly: false,
    projectId: summary.projectId ?? undefined,
    messages: messages.map((message) =>
      exportedMessage(
        message,
        message.attachments?.map((view) => {
          const { thumbnailBase64: _, ...attachment } = attachmentView(view)
          return Object.fromEntries(
            Object.entries(attachment).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Attachment
        }),
        summary.createdAt,
      ),
    ),
  }
}

async function cloudSummaries(
  api: HarnessAPI,
  signal: AbortSignal,
): Promise<ThreadSummary[]> {
  const summaries: ThreadSummary[] = []
  let cursor: string | undefined
  do {
    const page = await api.post<{
      threads: ThreadSummary[]
      nextCursor: string | null
    }>('/v1/threads/list', { cursor, limit: 100 }, signal)
    summaries.push(...page.threads)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return summaries
}

async function storedMessages(
  api: HarnessAPI,
  threadId: string,
  signal: AbortSignal,
): Promise<WireMessage[]> {
  const messages: WireMessage[] = []
  let before: string | undefined
  for (;;) {
    const page = await api.post<Thread>(
      '/v1/threads/get',
      { id: threadId, ...(before ? { before } : {}), limit: 200 },
      signal,
    )
    messages.unshift(...page.messages)
    if (!page.hasOlder || page.messages.length === 0) return messages
    before = page.messages[0].id
  }
}

// The transcript is refused while a reply streams or when an attachment
// cannot be read; the chat is then exported from its stored messages, with
// each attachment fetched on its own.
const readThroughMessages = (error: unknown) =>
  error instanceof HarnessError &&
  error.status === 409 &&
  (error.code === 'RUN_IN_FLIGHT' || error.code === 'ATTACHMENTS_UNAVAILABLE')

async function mapInOrder<T, R>(
  values: readonly T[],
  concurrency: number,
  read: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < values.length) {
      const index = next++
      try {
        results[index] = await read(values[index])
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  )
  return results
}

// Every chat the user can export from here: the chats kept on this device
// (in this tab when signed out) and, with cloud sync, the stored chats.
export async function collectChatExport(
  api: HarnessAPI,
  { cloud, signal }: { cloud: boolean; signal: AbortSignal },
): Promise<ChatExportSource> {
  const store = localThreadStore(api.userId ? 'device' : 'tab')
  const chats = new Map<string, Chat>()
  const heldImages = new Map<Attachment, Uint8Array>()
  const readOnRequest = new Set<string>()
  for (const summary of await store.list()) {
    signal.throwIfAborted()
    const thread = await store.get(summary.id)
    if (thread && !chats.has(thread.id))
      chats.set(thread.id, exportedChat(thread, { isLocalOnly: true }))
  }
  if (cloud) {
    const summaries = (await cloudSummaries(api, signal)).filter(
      (summary) => !chats.has(summary.id),
    )
    const stored = await mapInOrder(
      summaries,
      CLOUD_READ_CONCURRENCY,
      async (summary) => {
        const fields = {
          isLocalOnly: false,
          projectId: summary.projectId ?? undefined,
        }
        try {
          const thread = await cloudTranscript(api, summary.id, signal)
          return exportedChat(thread, fields, heldImages)
        } catch (error) {
          if (!readThroughMessages(error)) throw error
        }
        readOnRequest.add(summary.id)
        return storedChat(
          summary,
          await storedMessages(api, summary.id, signal),
        )
      },
    )
    for (const chat of stored) if (!chats.has(chat.id)) chats.set(chat.id, chat)
  }
  signal.throwIfAborted()
  return {
    chats: [...chats.values()],
    fetchAttachmentBytes: async (attachment, chat) => {
      signal.throwIfAborted()
      const held = heldImages.get(attachment)
      if (held) {
        heldImages.delete(attachment)
        return held
      }
      try {
        if (attachment.base64) return base64ToUint8Array(attachment.base64)
        if (!readOnRequest.has(chat.id)) return null
        const blob = await api.download(
          '/v1/attachments/get',
          { id: attachment.id, threadId: chat.id },
          signal,
        )
        return new Uint8Array(await blob.arrayBuffer())
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof DOMException && error.name === 'AbortError')
          throw error
        logWarning('Failed to fetch attachment for export', {
          component: 'chatExport',
          action: 'fetchAttachmentBytes',
          metadata: { attachmentId: attachment.id },
        })
        return null
      }
    },
  }
}
