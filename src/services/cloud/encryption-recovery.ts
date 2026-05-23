/**
 * Encryption Recovery
 *
 * Standalone operations for retrying decryption of chats that failed to decrypt
 * (e.g. after a key rotation) and re-encrypting all local chats with a new key.
 * These don't interact with the sync lock or sync caches.
 */

import { base64ToUint8Array } from '@/utils/binary-codec'
import { logError, logInfo } from '@/utils/error-handling'
import { encryptionService } from '../encryption/encryption-service'
import { indexedDBStorage, type StoredChat } from '../storage/indexed-db'
import { cloudStorage } from './cloud-storage'
import { streamingTracker } from './streaming-tracker'
import { isUploadableChat } from './sync-predicates'

// Retry decryption for chats that failed to decrypt
export async function retryDecryptionWithNewKey(
  options: {
    onProgress?: (current: number, total: number) => void
    batchSize?: number
  } = {},
): Promise<number> {
  const { onProgress } = options
  // Ensure batchSize is a positive integer, default to 5 if invalid
  const batchSize = Math.max(1, Math.floor(options.batchSize || 5))
  let decryptedCount = 0
  let chatsWithEncryptedData: StoredChat[] = []

  try {
    // Get all chats that have encrypted data
    chatsWithEncryptedData = await indexedDBStorage.getChatsWithEncryptedData()

    const total = chatsWithEncryptedData.length

    // Process chats in batches to avoid blocking the UI
    for (let i = 0; i < chatsWithEncryptedData.length; i += batchSize) {
      const batch = chatsWithEncryptedData.slice(i, i + batchSize)

      // Process batch in parallel
      const batchPromises = batch.map(async (chat) => {
        try {
          let decryptedData: any

          if (chat.formatVersion === 1) {
            // v1: encryptedData is base64-encoded binary
            const bytes = base64ToUint8Array(chat.encryptedData!)
            decryptedData = await encryptionService.decryptV1(bytes)
          } else {
            // v0: encryptedData is a JSON string
            const encryptedData = JSON.parse(chat.encryptedData!)
            decryptedData = await encryptionService.decrypt(encryptedData)
          }

          logInfo(`Decrypted chat ${chat.id}`, {
            component: 'CloudSync',
            action: 'retryDecryptionWithNewKey',
            metadata: {
              chatId: chat.id,
              decryptedTitle: decryptedData.title,
              messageCount: decryptedData.messages?.length || 0,
            },
          })

          // Create properly decrypted chat with original data
          const updatedChat: StoredChat = {
            ...decryptedData, // Use all decrypted data first
            id: chat.id, // Preserve the original ID
            decryptionFailed: false,
            encryptedData: undefined,
            formatVersion: chat.formatVersion ?? 0,
            syncedAt: chat.syncedAt,
            syncVersion: chat.syncVersion,
            locallyModified: false,
          }

          await indexedDBStorage.saveChat(updatedChat)
          return true
        } catch (error) {
          logError(`Failed to decrypt chat ${chat.id}`, error, {
            component: 'CloudSync',
            action: 'retryDecryptionWithNewKey',
            metadata: { chatId: chat.id },
          })
          return false
        }
      })

      const results = await Promise.all(batchPromises)
      decryptedCount += results.filter(Boolean).length

      // Report progress
      if (onProgress) {
        onProgress(Math.min(i + batchSize, total), total)
      }

      // Yield to the event loop between batches
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } catch (error) {
    logError('Failed to retry decryptions', error, {
      component: 'CloudSync',
      action: 'retryDecryptionWithNewKey',
    })
  }

  return decryptedCount
}

// Re-encrypt all local chats with new key and upload to cloud
export async function reencryptAndUploadChats(): Promise<{
  reencrypted: number
  uploaded: number
  errors: string[]
}> {
  const result = {
    reencrypted: 0,
    uploaded: 0,
    errors: [] as string[],
  }

  try {
    // Get all local chats
    const allChats = await indexedDBStorage.getAllChats()

    logInfo('Starting re-encryption of local chats', {
      component: 'CloudSync',
      action: 'reencryptAndUploadChats',
      metadata: { totalChats: allChats.length },
    })

    if (!(await cloudStorage.isAuthenticated())) {
      return result
    }

    for (const chat of allChats) {
      try {
        // Use centralized predicate for upload eligibility (including streaming check)
        if (
          !isUploadableChat(
            chat,
            streamingTracker.isStreaming.bind(streamingTracker),
          )
        ) {
          logInfo('Skipping ineligible chat during re-encryption', {
            component: 'CloudSync',
            action: 'reencryptAndUploadChats',
            metadata: {
              chatId: chat.id,
              isLocalOnly: chat.isLocalOnly,
              isBlankChat: chat.isBlankChat,
              decryptionFailed: chat.decryptionFailed,
              hasEncryptedData: !!chat.encryptedData,
              dataCorrupted: chat.dataCorrupted,
            },
          })
          continue
        }

        const syncVersion =
          (await cloudStorage.uploadChat(chat)) ?? (chat.syncVersion ?? 0) + 1

        chat.syncVersion = syncVersion
        await indexedDBStorage.saveChat(chat)
        await indexedDBStorage.markAsSynced(chat.id, syncVersion)
        result.uploaded++
        result.reencrypted++

        logInfo('Chat re-encrypted and uploaded', {
          component: 'CloudSync',
          action: 'reencryptAndUploadChats',
          metadata: {
            chatId: chat.id,
            syncVersion: chat.syncVersion,
          },
        })
      } catch (error) {
        const errorMsg = `Failed to re-encrypt chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`
        result.errors.push(errorMsg)
        logError('Failed to re-encrypt chat', error, {
          component: 'CloudSync',
          action: 'reencryptAndUploadChats',
          metadata: { chatId: chat.id },
        })
      }
    }

    logInfo('Completed re-encryption of local chats', {
      component: 'CloudSync',
      action: 'reencryptAndUploadChats',
      metadata: result,
    })
  } catch (error) {
    const errorMsg = `Re-encryption failed: ${error instanceof Error ? error.message : String(error)}`
    result.errors.push(errorMsg)
    logError('Failed to re-encrypt chats', error, {
      component: 'CloudSync',
      action: 'reencryptAndUploadChats',
    })
  }

  return result
}
