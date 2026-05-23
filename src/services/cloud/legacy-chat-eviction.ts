/**
 * One-shot cleanup that runs the first time a build with the
 * enclave-only sync path mounts. The legacy v0/v1 client-side decrypt
 * code is gone, so any locally cached cloud chats flagged
 * `decryptionFailed` (or stored under an older format version) are
 * now unreadable and would shadow the live enclave-rewrapped copy.
 * Dropping them lets the next sync pull fresh plaintext.
 *
 * Local-only chats (encrypted with DeviceEncryptionService) are
 * untouched because they never went through the cloud key path.
 */

import { MIGRATION_LEGACY_CLOUD_CHATS_EVICTED } from '@/constants/storage-keys'
import { logError, logInfo } from '@/utils/error-handling'
import { indexedDBStorage, type StoredChat } from '../storage/indexed-db'

function shouldEvict(chat: StoredChat): boolean {
  if (chat.isLocalOnly) return false
  if (chat.decryptionFailed) return true
  if (typeof chat.formatVersion === 'number' && chat.formatVersion < 2) {
    return true
  }
  return false
}

export async function runLegacyChatEvictionIfNeeded(): Promise<void> {
  if (typeof window === 'undefined') return
  let flag: string | null
  try {
    flag = localStorage.getItem(MIGRATION_LEGACY_CLOUD_CHATS_EVICTED)
  } catch {
    return
  }
  if (flag === '1') return

  let chats: StoredChat[]
  try {
    chats = await indexedDBStorage.getAllChats()
  } catch (error) {
    logError('Failed to read chats for legacy eviction', error, {
      component: 'LegacyChatEviction',
      action: 'runIfNeeded',
    })
    return
  }

  const toEvict = chats.filter(shouldEvict)
  let evicted = 0
  let failed = 0
  for (const chat of toEvict) {
    try {
      await indexedDBStorage.deleteChat(chat.id)
      evicted++
    } catch (error) {
      failed++
      logError(`Failed to evict legacy chat ${chat.id}`, error, {
        component: 'LegacyChatEviction',
        action: 'runIfNeeded',
        metadata: { chatId: chat.id },
      })
    }
  }

  // Only commit the one-shot flag once every targeted chat is gone.
  // A partial sweep leaves legacy rows behind; flipping the flag would
  // turn those transient failures into permanent ghosts because the
  // next mount would skip the retry.
  if (failed === 0) {
    try {
      localStorage.setItem(MIGRATION_LEGACY_CLOUD_CHATS_EVICTED, '1')
    } catch {
      // Ignore storage write failures; we'll retry on the next mount.
    }
  }

  if (evicted > 0) {
    logInfo('Evicted legacy chat placeholders', {
      component: 'LegacyChatEviction',
      action: 'runIfNeeded',
      metadata: { evicted, failed, total: toEvict.length },
    })
  }
}
