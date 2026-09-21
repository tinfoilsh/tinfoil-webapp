import type { Attachment, Chat, Message } from '@/components/chat/types'
import { forkChatTitle } from '@/constants/chat'

/**
 * Builds a client-side fork of `source` holding its first `messageCount`
 * messages. Only conversation content and settings carry over; sync
 * bookkeeping, recovery envelopes, and the per-chat sandbox token belong
 * to the source row and are left behind. Attachments get fresh ids and
 * shed any storage or server reference so the fork's first save stores
 * its own copies of their bytes. Cloud chats are forked by the sync
 * enclave instead, since their image bytes live server-side.
 */
export function buildForkedChat(
  source: Chat,
  messageCount: number,
  forkId: string,
): Chat {
  if (messageCount < 1 || messageCount > source.messages.length) {
    throw new RangeError('Fork point is outside the conversation')
  }
  return {
    id: forkId,
    title: forkChatTitle(source.title),
    titleState: 'manual',
    messages: source.messages.slice(0, messageCount).map(forkMessage),
    createdAt: new Date(),
    isBlankChat: false,
    isLocalOnly: source.isLocalOnly,
    projectId: source.projectId,
    presetId: source.presetId,
    model: source.model,
    webSearchEnabled: source.webSearchEnabled,
  }
}

function forkMessage(message: Message): Message {
  const { attachments, ...rest } = structuredClone(message)
  return attachments
    ? { ...rest, attachments: attachments.map(forkAttachment) }
    : rest
}

function forkAttachment(attachment: Attachment): Attachment {
  const {
    storagePayloadId: _storagePayloadId,
    encryptionKey: _encryptionKey,
    key: _key,
    ...content
  } = attachment as Attachment & { storagePayloadId?: string; key?: string }
  return { ...content, id: crypto.randomUUID() }
}
