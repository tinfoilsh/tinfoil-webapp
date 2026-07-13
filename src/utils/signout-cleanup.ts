import { resetRendererRegistry } from '@/components/chat/renderers'
import {
  AUTH_ACTIVE_USER_ID,
  SECRET_PASSKEY_BACKED_UP,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { resetEditClockCache } from '@/services/cloud/edit-clock'
import { profileSync } from '@/services/cloud/profile-sync'
import { invalidateProfileSyncGeneration } from '@/services/cloud/profile-sync-coordinator'
import { resetSyncHealth } from '@/services/cloud/sync-health'
import { encryptionService } from '@/services/encryption/encryption-service'
import { resetTinfoilClient } from '@/services/inference/tinfoil-client'
import { projectEvents } from '@/services/project/project-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { resetSyncEnclaveClient } from '@/services/sync-enclave'
import { logError, logInfo } from '@/utils/error-handling'

interface ClearUserDataOptions {
  /** If set, preserve this user ID in localStorage after clearing */
  preserveUserId?: string
  /** If true, keep the encryption key in localStorage (for signout without passkey backup) */
  preserveEncryptionKey?: boolean
  /** Logging context label */
  context: string
}

async function clearAllUserData(options: ClearUserDataOptions): Promise<void> {
  const { context, preserveUserId, preserveEncryptionKey } = options

  invalidateProfileSyncGeneration(true)
  cloudSync.resetForAccountChange()

  // Clear encryption key immediately (in-memory + localStorage) before any
  // async work, so concurrent code cannot re-persist a stale key.
  if (!preserveEncryptionKey) {
    encryptionService.clearKey({ persist: true })
  }

  // Reset renderer registry to clear any cached renderers
  resetRendererRegistry()

  // Reset tinfoil client to clear cached API key
  resetTinfoilClient()

  // Drop the verified sync-enclave SecureClient so the next signed-in
  // user re-runs attestation from scratch.
  resetSyncEnclaveClient()

  // Clear profile sync cache
  profileSync.clearCache()

  // Clear sync caches so stale state doesn't leak into the next session
  cloudSync.clearSyncStatus()
  deletedChatsTracker.clear()
  resetSyncHealth()

  // Drop the in-memory edit-clock counter/device-id so the next user
  // re-reads from cleared storage instead of inheriting this session's.
  resetEditClockCache()

  // Clear project event handlers
  projectEvents.clear()

  logInfo('Cleared in-memory caches', {
    component: context,
    action: 'clearAllUserData',
  })

  // Clear localStorage, preserving only non-user-specific keys
  try {
    const encryptionKey = preserveEncryptionKey
      ? localStorage.getItem(USER_ENCRYPTION_KEY)
      : null
    localStorage.clear()
    if (preserveUserId) {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, preserveUserId)
    }
    if (encryptionKey) {
      localStorage.setItem(USER_ENCRYPTION_KEY, encryptionKey)
    }
  } catch {
    // best-effort — don't let localStorage failures skip remaining cleanup
  }

  // Clear sessionStorage
  try {
    sessionStorage.clear()
  } catch {
    // best-effort
  }

  // Clear IndexedDB
  try {
    await indexedDBStorage.deleteAllChats()
  } catch (error) {
    logError('Failed to clear IndexedDB', error, {
      component: context,
      action: 'clearAllUserData',
    })
  }

  // Clear service worker caches
  if ('caches' in window) {
    try {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map((name) => caches.delete(name)))
    } catch {
      // best-effort
    }
  }
}

export async function performSignoutCleanup(opts?: {
  preserveEncryptionKey?: boolean
}): Promise<void> {
  const preserveKey = opts?.preserveEncryptionKey ?? false
  const action = preserveKey
    ? 'performSignoutCleanup(preserveKey)'
    : 'performSignoutCleanup'

  try {
    logInfo(
      `Starting signout cleanup${preserveKey ? ' (preserving encryption key)' : ''}`,
      {
        component: 'signoutCleanup',
        action,
      },
    )

    await clearAllUserData({
      context: 'signoutCleanup',
      preserveEncryptionKey: preserveKey,
    })

    logInfo(
      `Signout cleanup completed${preserveKey ? ' (encryption key preserved)' : ''}`,
      {
        component: 'signoutCleanup',
        action,
      },
    )
  } catch (error) {
    logError('Error during signout cleanup', error, {
      component: 'signoutCleanup',
      action,
    })
    throw error
  }
}

/**
 * Delete just the encryption key from localStorage and clear the in-memory copy.
 * Called after the user downloads their key from the signout modal.
 */
export function deleteEncryptionKey(): void {
  encryptionService.clearKey({ persist: true })
}

export function performUserSwitchCleanup(newUserId: string): void {
  logInfo('User switch detected, clearing all data', {
    component: 'AuthCleanupHandler',
    action: 'performUserSwitchCleanup',
    metadata: { newUserId },
  })

  clearAllUserData({
    context: 'AuthCleanupHandler',
    preserveUserId: newUserId,
  })
    .catch((error) => {
      logError('Failed to clear user data during switch', error, {
        component: 'AuthCleanupHandler',
        action: 'performUserSwitchCleanup',
      })
    })
    .finally(() => {
      window.location.reload()
    })
}

export function getEncryptionKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(USER_ENCRYPTION_KEY)
}

export function hasPasskeyBackup(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(SECRET_PASSKEY_BACKED_UP) === 'true'
}
