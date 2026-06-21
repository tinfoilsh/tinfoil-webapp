import { strToU8, zipSync } from 'fflate'

import type { Attachment, Chat } from '@/components/chat/types'

/**
 * Off-device-import-compatible chat export. When any exported chat has
 * a binary (image) attachment, the export is a ZIP containing:
 *
 *   - conversations.json: Claude-compatible conversation JSON enriched
 *     with Tinfoil attachment metadata (the sync enclave's Tinfoil
 *     importer reads exactly this shape).
 *   - attachments/<attachment-id>/<safe-filename>: raw attachment bytes.
 *   - manifest.json: export version, counts, and per-file SHA-256.
 *
 * conversations.json never carries `encryptionKey` or inline binary
 * base64 — keys stay client-side and binaries live as ZIP entries.
 *
 * When there are no binary attachments the export stays a plain
 * conversations.json string, preserving the previous behavior.
 */

export const EXPORT_VERSION = 1
const ATTACHMENTS_DIR = 'attachments'
const CONVERSATIONS_FILE = 'conversations.json'
const MANIFEST_FILE = 'manifest.json'

/** Fetches the raw bytes for one binary attachment, or null when unavailable. */
export type AttachmentBytesFetcher = (
  attachment: Attachment,
) => Promise<Uint8Array | null>

export interface ExportArchive {
  /** ZIP bytes when `isZip`, otherwise the conversations.json string. */
  data: Uint8Array | string
  filename: string
  mimeType: string
  isZip: boolean
  chatCount: number
  attachmentCount: number
  warnings: string[]
}

interface ExportedAttachment {
  id: string
  type: 'image' | 'document'
  fileName: string
  mimeType?: string
  fileSize?: number
  exportPath?: string
  textContent?: string
}

interface ManifestEntry {
  exportPath: string
  sha256: string
  fileSize: number
}

function isBinaryImage(att: Attachment): boolean {
  return att.type === 'image'
}

function chatsHaveBinaryAttachments(chats: Chat[]): boolean {
  return chats.some((chat) =>
    chat.messages.some((msg) => (msg.attachments ?? []).some(isBinaryImage)),
  )
}

/**
 * Strip path separators and control characters so an attachment file
 * name can be written as a ZIP entry without escaping its directory.
 */
export function sanitizeFilename(name: string, fallback: string): string {
  const base = (name || '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._ ()+-]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : fallback
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength)
  view.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view))
  let out = ''
  for (let i = 0; i < digest.length; i++) {
    out += digest[i].toString(16).padStart(2, '0')
  }
  return out
}

function toClaudeContent(thoughts?: string) {
  if (!thoughts) return undefined
  return [{ type: 'thinking', thinking: thoughts }]
}

/**
 * Build the export. `fetchAttachmentBytes` is called for one binary
 * attachment at a time so the browser never holds every attachment's
 * bytes in memory at once. Failed fetches keep the attachment's
 * metadata and add a manifest warning instead of aborting the export.
 */
export async function buildChatExport(
  chats: Chat[],
  fetchAttachmentBytes: AttachmentBytesFetcher,
): Promise<ExportArchive> {
  const needsZip = chatsHaveBinaryAttachments(chats)
  const warnings: string[] = []
  const zipFiles: Record<string, Uint8Array> = {}
  const manifestEntries: ManifestEntry[] = []
  let attachmentCount = 0

  const conversations = []
  for (const chat of chats) {
    const chatMessages = []
    for (let index = 0; index < chat.messages.length; index++) {
      const message = chat.messages[index]
      const exportedAttachments: ExportedAttachment[] = []

      for (const att of message.attachments ?? []) {
        if (isBinaryImage(att)) {
          attachmentCount++
          const safeName = sanitizeFilename(att.fileName, `${att.id}.bin`)
          const exportPath = `${ATTACHMENTS_DIR}/${att.id}/${safeName}`
          const exported: ExportedAttachment = {
            id: att.id,
            type: 'image',
            fileName: safeName,
            mimeType: att.mimeType,
            fileSize: att.fileSize,
          }

          if (needsZip) {
            const bytes = await fetchAttachmentBytes(att)
            if (bytes) {
              zipFiles[exportPath] = bytes
              exported.exportPath = exportPath
              exported.fileSize = bytes.byteLength
              manifestEntries.push({
                exportPath,
                sha256: await sha256Hex(bytes),
                fileSize: bytes.byteLength,
              })
            } else {
              warnings.push(`Could not fetch attachment ${att.id}`)
            }
          }
          exportedAttachments.push(exported)
        } else {
          attachmentCount++
          exportedAttachments.push({
            id: att.id,
            type: 'document',
            fileName: att.fileName,
            mimeType: att.mimeType,
            fileSize: att.fileSize,
            textContent: att.textContent,
          })
        }
      }

      chatMessages.push({
        uuid: `${chat.id}_msg_${index}`,
        text: message.content,
        sender: message.role === 'user' ? 'human' : 'assistant',
        created_at: new Date(message.timestamp).toISOString(),
        ...(toClaudeContent(message.thoughts)
          ? { content: toClaudeContent(message.thoughts) }
          : {}),
        ...(exportedAttachments.length > 0
          ? { attachments: exportedAttachments }
          : {}),
      })
    }

    conversations.push({
      uuid: chat.id,
      name: chat.title,
      created_at: new Date(chat.createdAt).toISOString(),
      updated_at: new Date(chat.createdAt).toISOString(),
      ...(chat.projectId ? { projectId: chat.projectId } : {}),
      chat_messages: chatMessages,
    })
  }

  const conversationsJson = JSON.stringify(conversations, null, 2)

  if (!needsZip) {
    return {
      data: conversationsJson,
      filename: CONVERSATIONS_FILE,
      mimeType: 'application/json',
      isZip: false,
      chatCount: chats.length,
      attachmentCount,
      warnings,
    }
  }

  zipFiles[CONVERSATIONS_FILE] = strToU8(conversationsJson)
  zipFiles[MANIFEST_FILE] = strToU8(
    JSON.stringify(
      {
        version: EXPORT_VERSION,
        created_at: new Date().toISOString(),
        chat_count: chats.length,
        attachment_count: attachmentEntriesWritten(manifestEntries),
        attachments: manifestEntries,
        warnings,
      },
      null,
      2,
    ),
  )

  const zipped = zipSync(zipFiles)
  return {
    data: zipped,
    filename: 'tinfoil-chats.zip',
    mimeType: 'application/zip',
    isZip: true,
    chatCount: chats.length,
    attachmentCount,
    warnings,
  }
}

function attachmentEntriesWritten(entries: ManifestEntry[]): number {
  return entries.length
}
