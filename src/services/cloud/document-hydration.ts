import type { Message } from '@/components/chat/types'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { attachmentGet } from '../sync-enclave/sync-api'
import { createActiveAccountGuard } from './account-operation'
import {
  decodeDocumentPayload,
  hasInlineDocumentPayload,
  isServerKeyedDocument,
  validateDocumentPayload,
} from './document-payload'

export class DocumentHydrationError extends Error {
  constructor(
    readonly reason: 'sync_disabled' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(
      reason === 'sync_disabled'
        ? 'Document content is not on this device. Enable cloud sync to download it, then retry.'
        : 'Document content could not be loaded. Please retry before continuing.',
      options,
    )
    this.name = 'DocumentHydrationError'
  }
}

export function requireDocumentCloudRead(): void {
  if (!isCloudSyncEnabled()) throw new DocumentHydrationError('sync_disabled')
}

/** Strict, serial reads for operations that must not proceed with missing content. */
export async function hydrateDocumentAttachments(
  messages: Message[],
  signal?: AbortSignal,
): Promise<Message[]> {
  const guard = createActiveAccountGuard(signal)
  try {
    guard.assertCurrent()
    const hydrated: Message[] = []
    for (const message of messages) {
      if (
        !message.attachments?.some(
          (attachment) => attachment.type === 'document',
        )
      ) {
        hydrated.push(message)
        continue
      }
      const attachments = []
      for (const attachment of message.attachments) {
        guard.assertCurrent()
        if (attachment.type !== 'document') {
          attachments.push(attachment)
          continue
        }
        if (hasInlineDocumentPayload(attachment)) {
          attachments.push({
            ...attachment,
            ...validateDocumentPayload(attachment.id, attachment),
          })
          continue
        }
        if (!isServerKeyedDocument(attachment))
          throw new DocumentHydrationError('unavailable')
        requireDocumentCloudRead()
        try {
          const bytes = await attachmentGet(
            { id: attachment.id, attKeyB64: attachment.encryptionKey! },
            signal,
          )
          guard.assertCurrent()
          requireDocumentCloudRead()
          attachments.push({
            ...attachment,
            ...decodeDocumentPayload(attachment.id, bytes),
          })
        } catch (error) {
          guard.assertCurrent()
          requireDocumentCloudRead()
          throw new DocumentHydrationError('unavailable', { cause: error })
        }
      }
      hydrated.push({ ...message, attachments })
    }
    guard.assertCurrent()
    return hydrated
  } finally {
    guard.dispose()
  }
}
