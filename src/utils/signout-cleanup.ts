import { resetRendererRegistry } from '@/components/chat/renderers'
import {
  AUTH_ACTIVE_USER_ID,
  SECRET_PASSKEY_BACKED_UP,
  SETTINGS_HAS_SEEN_ONBOARDING,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { resetEditClockCache } from '@/services/cloud/edit-clock'
import { profileSync } from '@/services/cloud/profile-sync'
import { resetSyncHealth } from '@/services/cloud/sync-health'
import { encryptionService } from '@/services/encryption/encryption-service'
import { resetTinfoilClient } from '@/services/inference/tinfoil-client'
import { projectEvents } from '@/services/project/project-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { resetSyncEnclaveClient } from '@/services/sync-enclave'
import { logError, logInfo } from '@/utils/error-handling'
import {
  completeSignoutStep,
  reportSignoutStep,
  SIGNOUT_STEPS,
} from '@/utils/signout-progress'

interface ClearUserDataOptions {
  /** If set, preserve this user ID in localStorage after clearing */
  preserveUserId?: string
  /** If true, keep the encryption key in localStorage (for signout without passkey backup) */
  preserveEncryptionKey?: boolean
  /**
   * If true, don't surface progress in the signout overlay. Used for
   * user-switch cleanup, which is not a signout.
   */
  skipProgressReporting?: boolean
  /** Logging context label */
  context: string
}

async function clearAllUserData(options: ClearUserDataOptions): Promise<void> {
  const {
    context,
    preserveUserId,
    preserveEncryptionKey,
    skipProgressReporting = false,
  } = options

  const reportStep = (step: number) => {
    if (!skipProgressReporting) reportSignoutStep(step)
  }
  const completeStep = (step: number) => {
    if (!skipProgressReporting) completeSignoutStep(step)
  }

  // Clear encryption key immediately (in-memory + localStorage) before any
  // async work, so concurrent code cannot re-persist a stale key.
  reportStep(SIGNOUT_STEPS.CLEAR_KEY)
  if (!preserveEncryptionKey) {
    encryptionService.clearKey({ persist: true })
  }
  completeStep(SIGNOUT_STEPS.CLEAR_KEY)

  // Reset renderer registry to clear any cached renderers
  reportStep(SIGNOUT_STEPS.RESET_CACHES)
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
  completeStep(SIGNOUT_STEPS.RESET_CACHES)

  // Clear localStorage, preserving only non-user-specific keys
  reportStep(SIGNOUT_STEPS.CLEAR_STORAGE)
  try {
    const encryptionKey = preserveEncryptionKey
      ? localStorage.getItem(USER_ENCRYPTION_KEY)
      : null
    const hasSeenOnboarding = localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)
    localStorage.clear()
    if (hasSeenOnboarding !== null) {
      localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, hasSeenOnboarding)
    }
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
  completeStep(SIGNOUT_STEPS.CLEAR_STORAGE)

  // Clear IndexedDB
  reportStep(SIGNOUT_STEPS.CLEAR_BROWSING_DATA)
  try {
    await indexedDBStorage.clearAll()
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
  completeStep(SIGNOUT_STEPS.CLEAR_BROWSING_DATA)
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
    skipProgressReporting: true,
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
