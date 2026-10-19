import type { Attachment, Message } from '@/components/chat/types'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { attachmentGet } from '../sync-enclave/sync-api'
import { createActiveAccountGuard } from './account-operation'
import {
  decodeDocumentPayload,
  DocumentPayloadDecodeError,
  hasInlineDocumentPayload,
  isServerKeyedDocument,
  validateDocumentPayload,
} from './document-payload'

export type DocumentHydrationFailure =
  'sync_disabled' | 'unavailable' | 'invalid'

function describeHydrationFailure(
  reason: DocumentHydrationFailure,
  fileName?: string,
): string {
  switch (reason) {
    case 'sync_disabled':
      return 'Document content is not on this device. Enable cloud sync to download it, then retry.'
    case 'unavailable':
      return 'Document content could not be loaded. Please retry before continuing.'
    case 'invalid':
      return `The attachment "${fileName ?? 'document'}" could not be read. Remove it and attach the file again.`
  }
}

export class DocumentHydrationError extends Error {
  constructor(
    readonly reason: DocumentHydrationFailure,
    options?: ErrorOptions & { fileName?: string },
  ) {
    super(describeHydrationFailure(reason, options?.fileName), options)
    this.name = 'DocumentHydrationError'
  }
}

function toHydrationError(
  attachment: Attachment,
  error: unknown,
): DocumentHydrationError {
  if (error instanceof DocumentPayloadDecodeError) {
    logError('Document attachment failed validation', error, {
      component: 'DocumentHydration',
      metadata: { attachmentId: attachment.id, fileName: attachment.fileName },
    })
    return new DocumentHydrationError('invalid', {
      cause: error,
      fileName: attachment.fileName,
    })
  }
  return new DocumentHydrationError('unavailable', { cause: error })
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
          try {
            attachments.push({
              ...attachment,
              ...validateDocumentPayload(attachment.id, attachment),
            })
          } catch (error) {
            throw toHydrationError(attachment, error)
          }
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
          throw toHydrationError(attachment, error)
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
