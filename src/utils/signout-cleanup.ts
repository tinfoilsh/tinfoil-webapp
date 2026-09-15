import { resetRendererRegistry } from '@/components/chat/renderers'
import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACTIVE_USER_ID,
  SECRET_PASSKEY_BACKED_UP,
  SETTINGS_HAS_SEEN_ONBOARDING,
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import { encryptionService } from '@/services/encryption/encryption-service'
import { resetHarnessAPI } from '@/services/harness/runtime'
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

  resetHarnessAPI()
  authTokenManager.reset()
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

  logInfo('Cleared in-memory caches', {
    component: context,
    action: 'clearAllUserData',
  })
  completeStep(SIGNOUT_STEPS.RESET_CACHES)

  // Clear localStorage, preserving only non-user-specific keys
  reportStep(SIGNOUT_STEPS.CLEAR_STORAGE)
  try {
    const preservedKeys = new Set([
      AUTH_ACTIVE_USER_ID,
      SETTINGS_HAS_SEEN_ONBOARDING,
      ...(preserveEncryptionKey
        ? [USER_ENCRYPTION_KEY, USER_ENCRYPTION_KEY_HISTORY]
        : []),
    ])
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    )
    for (const key of keys) {
      if (key && !preservedKeys.has(key)) {
        localStorage.removeItem(key)
      }
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
    await deleteLegacyDatabase()
  } catch (error) {
    logError('Failed to clear IndexedDB', error, {
      component: context,
      action: 'clearAllUserData',
    })
    throw error
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

  if (preserveUserId) {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, preserveUserId)
  } else {
    localStorage.removeItem(AUTH_ACTIVE_USER_ID)
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

    try {
      await clearAllUserData({
        context: 'signoutCleanup',
        preserveEncryptionKey: preserveKey,
      })
    } finally {
      window.dispatchEvent(
        new CustomEvent(PINNED_CHAT_IDS_CHANGED_EVENT, {
          detail: { pinnedChatIds: [] },
        }),
      )
    }

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

export async function performUserSwitchCleanup(
  newUserId: string,
): Promise<void> {
  logInfo('User switch detected, clearing all data', {
    component: 'AuthCleanupHandler',
    action: 'performUserSwitchCleanup',
    metadata: { newUserId },
  })

  try {
    await clearAllUserData({
      context: 'AuthCleanupHandler',
      preserveUserId: newUserId,
      skipProgressReporting: true,
    })
  } catch (error) {
    logError('Failed to clear user data during switch', error, {
      component: 'AuthCleanupHandler',
      action: 'performUserSwitchCleanup',
    })
    throw error
  }
}

export function getEncryptionKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(USER_ENCRYPTION_KEY)
}

export function hasPasskeyBackup(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(SECRET_PASSKEY_BACKED_UP) === 'true'
}

export async function retryFailedStorageCleanup(): Promise<void> {
  await deleteLegacyDatabase()
  sessionStorage.removeItem(AUTH_ACCOUNT_RESET_FAILED)
}

async function deleteLegacyDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('tinfoil-chat')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('Close other Tinfoil tabs before clearing this device.'))
  })
}
