import type { Attachment, DocumentPage } from '@/components/chat/types'

/**
 * Document attachment content stored as an enclave attachment blob.
 *
 * Images already live outside the chat JSON: the bytes are uploaded as
 * a blob and the chat keeps `id` + `encryptionKey`. Documents used to
 * ride inline (`textContent`, and for scanned PDFs one base64 image per
 * page), which is what pushed large chats over the sync size limit.
 * This module is the single definition of what leaves the chat JSON
 * for a document and how it is serialized, so upload, hydration,
 * export, and backup all agree.
 */
export interface DocumentPayload {
  textContent?: string
  pages?: DocumentPage[]
}

export function hasInlineDocumentPayload(attachment: Attachment): boolean {
  return (
    attachment.type === 'document' &&
    (attachment.textContent !== undefined || attachment.pages !== undefined)
  )
}

/**
 * A document whose content has been uploaded: it carries the enclave's
 * key but neither inline field. Readers must fetch and decode the blob
 * before using the content.
 */
export function isOffloadedDocument(attachment: Attachment): boolean {
  return (
    attachment.type === 'document' &&
    typeof attachment.encryptionKey === 'string' &&
    attachment.encryptionKey.length > 0 &&
    attachment.textContent === undefined &&
    attachment.pages === undefined
  )
}

export function encodeDocumentPayload(
  attachment: Attachment,
): Uint8Array<ArrayBuffer> {
  const payload: DocumentPayload = {}
  if (attachment.textContent !== undefined) {
    payload.textContent = attachment.textContent
  }
  if (attachment.pages !== undefined) {
    payload.pages = attachment.pages
  }
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const owned = new Uint8Array(encoded.byteLength)
  owned.set(encoded)
  return owned
}

export class DocumentPayloadDecodeError extends Error {
  constructor(attachmentId: string, options?: ErrorOptions) {
    super(`Document payload for ${attachmentId} is not valid`, options)
    this.name = 'DocumentPayloadDecodeError'
  }
}

export function decodeDocumentPayload(
  attachmentId: string,
  bytes: Uint8Array,
): DocumentPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new DocumentPayloadDecodeError(attachmentId, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DocumentPayloadDecodeError(attachmentId)
  }
  const record = parsed as Record<string, unknown>
  const payload: DocumentPayload = {}
  if (record.textContent !== undefined) {
    if (typeof record.textContent !== 'string') {
      throw new DocumentPayloadDecodeError(attachmentId)
    }
    payload.textContent = record.textContent
  }
  if (record.pages !== undefined) {
    if (!Array.isArray(record.pages)) {
      throw new DocumentPayloadDecodeError(attachmentId)
    }
    payload.pages = record.pages as DocumentPage[]
  }
  return payload
}

/**
 * Strip the offloaded fields from a document for the outgoing chat
 * envelope. Everything else (fileName, mimeType, fileSize, description,
 * id, encryptionKey) stays so the sidebar and prompt builder can show
 * the attachment before its content arrives.
 */
export function stripDocumentPayload(attachment: Attachment): Attachment {
  const { textContent: _text, pages: _pages, ...rest } = attachment
  return rest
}
