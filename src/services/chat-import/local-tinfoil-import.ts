import { strFromU8, unzipSync } from 'fflate'

import type { Attachment, Chat, Message } from '@/components/chat/types'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'

const CONVERSATIONS_FILE = 'conversations.json'
const MANIFEST_FILE = 'manifest.json'
export const LOCAL_IMPORT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

interface TinfoilExportedAttachment {
  id: string
  type: 'image' | 'document'
  fileName: string
  mimeType?: string
  fileSize?: number
  exportPath?: string
  textContent?: string
}

interface TinfoilExportedMessage {
  text: string
  sender: 'human' | 'assistant'
  created_at: string
  content?: Array<{
    type: string
    thinking?: string
  }>
  attachments?: TinfoilExportedAttachment[]
}

interface TinfoilExportedConversation {
  name: string
  created_at: string
  updated_at?: string
  projectId?: string
  chat_messages: TinfoilExportedMessage[]
}

export interface LocalTinfoilImportOptions {
  generateChatId: (createdAt?: Date) => string
}

function isZip(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
  )
}

async function readExport(file: File): Promise<{
  conversations: TinfoilExportedConversation[]
  entries?: Record<string, Uint8Array>
}> {
  if (file.size === 0) {
    throw new Error('The export file is empty')
  }
  if (file.size > LOCAL_IMPORT_MAX_ARCHIVE_BYTES) {
    throw new Error('The export file is too large')
  }

  if (!isZip(file)) {
    const conversations = JSON.parse(await file.text())
    if (!Array.isArray(conversations)) {
      throw new Error('Invalid Tinfoil export format')
    }
    return { conversations }
  }

  let uncompressedBytes = 0
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      const isImportEntry =
        entry.name === CONVERSATIONS_FILE ||
        entry.name === MANIFEST_FILE ||
        entry.name.startsWith('attachments/')
      if (!isImportEntry) return false

      uncompressedBytes += entry.originalSize
      if (uncompressedBytes > LOCAL_IMPORT_MAX_ARCHIVE_BYTES) {
        throw new Error('The uncompressed export is too large')
      }
      return true
    },
  })
  const conversationsEntry = entries[CONVERSATIONS_FILE]
  if (!conversationsEntry) {
    throw new Error('The Tinfoil export is missing conversations.json')
  }

  const conversations = JSON.parse(strFromU8(conversationsEntry))
  if (!Array.isArray(conversations)) {
    throw new Error('Invalid Tinfoil export format')
  }
  return { conversations, entries }
}

function importAttachment(
  attachment: TinfoilExportedAttachment,
  entries?: Record<string, Uint8Array>,
): Attachment {
  const imported: Attachment = {
    id: attachment.id,
    type: attachment.type,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    textContent: attachment.textContent,
  }

  if (attachment.type === 'image' && attachment.exportPath) {
    const bytes = entries?.[attachment.exportPath]
    if (!bytes) {
      throw new Error(`The export is missing ${attachment.exportPath}`)
    }
    imported.base64 = uint8ArrayToBase64(bytes)
    imported.fileSize = bytes.byteLength
  }

  return imported
}

export async function parseLocalTinfoilExport(
  file: File,
  options: LocalTinfoilImportOptions,
): Promise<Chat[]> {
  const { conversations, entries } = await readExport(file)
  const chats: Chat[] = []

  for (const conversation of conversations) {
    const messages: Message[] = []

    for (const exportedMessage of conversation.chat_messages ?? []) {
      const content = exportedMessage.text?.trim()
      if (!content) continue

      const message: Message = {
        role: exportedMessage.sender === 'human' ? 'user' : 'assistant',
        content,
        timestamp: new Date(exportedMessage.created_at),
      }
      const attachments = (exportedMessage.attachments ?? []).map(
        (attachment) => importAttachment(attachment, entries),
      )
      if (attachments.length > 0) {
        message.attachments = attachments
      }

      if (message.role === 'assistant') {
        const thoughts = (exportedMessage.content ?? [])
          .filter((block) => block.type === 'thinking' && block.thinking)
          .map((block) => block.thinking)
          .join('\n\n')
        if (thoughts) {
          message.thoughts = thoughts
        }
      }

      messages.push(message)
    }

    if (messages.length > 0) {
      const createdAt = new Date(conversation.created_at)
      // Local import does not restore projects, and the sidebar hides
      // chats whose projectId has no matching project, so drop the
      // exported project association.
      chats.push({
        id: options.generateChatId(createdAt),
        title: conversation.name || 'Imported Chat',
        messages,
        createdAt,
        updatedAt: conversation.updated_at,
        isLocalOnly: true,
      })
    }
  }

  return chats
}
