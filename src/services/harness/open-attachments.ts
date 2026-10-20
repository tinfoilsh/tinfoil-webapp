import type { AttachmentOriginal } from '@/services/storage/indexed-db'
import { base64ToUint8Array } from '@/utils/binary-codec'
import type { AttachmentDescriptor, StoredThread, Turn } from './types'

export const imageBlob = (image: { base64: string; mimeType?: string }) =>
  new Blob([base64ToUint8Array(image.base64)], {
    type: image.mimeType || 'image/jpeg',
  })

// The attachments of a turn that are new uploads, rather than ones the chat
// stores already.
export const uploaded = (attachments: Turn['attachments'] = []) =>
  attachments.filter(
    (attachment): attachment is AttachmentDescriptor => 'kind' in attachment,
  )

// What the open chat's view reads of its attachments: the image bytes a
// chat on this device holds, uploads the chat does not store yet, the files
// the user picked for them, and the document texts read so far. Clearing it
// moves the view to another chat.
export class OpenAttachments {
  readonly images = new Map<string, { base64: string; mimeType?: string }>()
  readonly uploads = new Map<string, AttachmentDescriptor>()
  readonly originals = new Map<string, AttachmentOriginal>()
  private readonly texts = new Map<string, Promise<string>>()

  // The originals of the images of a turn, by attachment id.
  originalsOf(attachments: readonly AttachmentDescriptor[]) {
    const found = new Map<string, AttachmentOriginal>()
    for (const { id } of attachments) {
      const original = this.originals.get(id)
      if (original) found.set(id, original)
    }
    return found
  }

  remember(attachments: readonly AttachmentDescriptor[]) {
    for (const attachment of attachments)
      if (attachment.base64)
        this.images.set(attachment.id, {
          base64: attachment.base64,
          mimeType: attachment.mimeType,
        })
  }

  rememberThread(thread: StoredThread) {
    for (const message of thread.messages)
      this.remember(message.attachments ?? [])
  }

  // The attachments a turn sends stay readable until the chat stores them.
  rememberSent(attachments: Turn['attachments']) {
    for (const attachment of uploaded(attachments))
      this.uploads.set(attachment.id, attachment)
    this.remember(uploaded(attachments))
  }

  // A document's text, read once; a failed read is tried again next time.
  text(id: string, read: () => Promise<string>): Promise<string> {
    const cached = this.texts.get(id)
    if (cached) return cached
    const reading = read()
    this.texts.set(id, reading)
    reading.catch(() => {
      if (this.texts.get(id) === reading) this.texts.delete(id)
    })
    return reading
  }

  clear() {
    this.images.clear()
    this.uploads.clear()
    this.originals.clear()
    this.texts.clear()
  }
}
