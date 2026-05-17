import {
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import {
  authorizeCurrentPrimaryKeyOrThrow,
  canWriteToCloud,
  clearCloudKeyAuthorization,
} from '@/services/cloud/cloud-key-authorization'
import { validateCurrentPrimaryKey } from '@/services/cloud/cloud-key-preflight'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { hasPasskeyBackup } from '@/utils/signout-cleanup'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface CloudSyncState {
  syncing: boolean
  lastSyncTime: number | null
  encryptionKey: string | null
  /** True once the init effect has finished (encryption key resolved) */
  initialized: boolean
  decryptionProgress: {
    isDecrypting: boolean
    current: number
    total: number
  } | null
}

interface UseCloudSyncOptions {
  /** Called after a key change so the passkey hook can re-encrypt the backup */
  onKeyChanged?: () => void
}

type CloudKeyActivationMode = 'recoverExisting' | 'explicitStartFresh'

export function useCloudSync(options?: UseCloudSyncOptions) {
  const { getToken, isSignedIn } = useAuth()
  const [state, setState] = useState<CloudSyncState>({
    syncing: false,
    lastSyncTime: null,
    encryptionKey: null,
    initialized: false,
    decryptionProgress: null,
  })
  const syncingRef = useRef(false)
  const initializingRef = useRef(false)
  const isMountedRef = useRef(true)
  // Ref avoids putting `options` in useCallback dep arrays, which would
  // recreate setEncryptionKey every render (options is a fresh object each time).
  const onKeyChangedRef = useRef(options?.onKeyChanged)
  onKeyChangedRef.current = options?.onKeyChanged

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Listen for fallback key additions and trigger retry decryption
  useEffect(() => {
    const unsubscribe = encryptionService.onFallbackKeyAdded(() => {
      logInfo('Fallback key added, triggering decryption retry', {
        component: 'useCloudSync',
        action: 'onFallbackKeyAdded',
      })

      // Run decryption retry in background
      cloudSync
        .retryDecryptionWithNewKey()
        .then((decryptedCount) => {
          if (decryptedCount > 0) {
            logInfo(`Decrypted ${decryptedCount} chats with new fallback key`, {
              component: 'useCloudSync',
              action: 'onFallbackKeyAdded',
              metadata: { decryptedCount },
            })
          }
        })
        .catch((error) => {
          logError(
            'Failed to retry decryption after fallback key added',
            error,
            {
              component: 'useCloudSync',
              action: 'onFallbackKeyAdded',
            },
          )
        })
    })

    return unsubscribe
  }, [])

  // Initialize cloud sync when user is signed in
  useEffect(() => {
    const initializeSync = async () => {
      if (!isSignedIn || initializingRef.current) return

      initializingRef.current = true

      try {
        authTokenManager.initialize(getToken)

        const existingKey = localStorage.getItem(USER_ENCRYPTION_KEY)

        // Backwards compatibility: if an encryption key exists but cloud sync is not enabled,
        // automatically enable it (existing users should have sync enabled by default)
        // BUT respect if user explicitly disabled it
        let cloudSyncEnabled = isCloudSyncEnabled()
        const explicitlyDisabled =
          localStorage.getItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED) ===
          'true'

        if (existingKey && !cloudSyncEnabled && !explicitlyDisabled) {
          setCloudSyncEnabled(true)
          cloudSyncEnabled = true
          logInfo('Automatically enabled cloud sync for existing user', {
            component: 'useCloudSync',
            action: 'initializeSync',
          })
        }

        // Initialize encryption (does not auto-generate keys)
        const key = await encryptionService.initialize()

        // Ensure the current key is authorized for cloud writes.
        // Existing users upgrading may have a valid key but no
        // authorization record yet.
        if (key && !(await canWriteToCloud())) {
          const validation = await validateCurrentPrimaryKey()
          if (validation.canWrite) {
            await authorizeCurrentPrimaryKeyOrThrow('validated')
          }
        }

        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            encryptionKey: key,
            initialized: true,
          }))
        }

        // Only perform sync operations if cloud sync is enabled
        if (!isCloudSyncEnabled()) {
          logInfo('Cloud sync is disabled, skipping sync operations', {
            component: 'useCloudSync',
            action: 'initializeSync',
          })
          return
        }
      } catch (error) {
        logError('Failed to initialize cloud sync', error, {
          component: 'useCloudSync',
          action: 'initializeSync',
        })
        // Still mark as initialized so passkey hook can proceed
        if (isMountedRef.current) {
          setState((prev) => ({ ...prev, initialized: true }))
        }
      } finally {
        initializingRef.current = false
      }
    }

    initializeSync()
  }, [isSignedIn, getToken])

  // Full sync chats (always fetches first page)
  const syncChats = useCallback(async () => {
    if (!isCloudSyncEnabled()) {
      logInfo('Cloud sync is disabled, skipping sync', {
        component: 'useCloudSync',
        action: 'syncChats',
      })
      return false
    }

    if (syncingRef.current) {
      logInfo('Sync request blocked - sync already in progress', {
        component: 'useCloudSync',
        action: 'syncChats',
      })
      return false
    }

    syncingRef.current = true
    if (isMountedRef.current) {
      setState((prev) => ({ ...prev, syncing: true }))
    }

    try {
      const result = await cloudSync.syncAllChats()

      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          syncing: false,
          lastSyncTime: Date.now(),
        }))
      }

      logInfo(
        `Sync completed: uploaded=${result.uploaded}, downloaded=${result.downloaded}`,
        {
          component: 'useCloudSync',
          action: 'syncChats',
          metadata: { result },
        },
      )

      return result
    } catch (error) {
      if (isMountedRef.current) {
        setState((prev) => ({ ...prev, syncing: false }))
      }
      throw error
    } finally {
      syncingRef.current = false
    }
  }, [])

  /**
   * Smart sync: checks sync status first and only syncs if changes detected.
   * @param projectId - Optional project ID. If provided, syncs project chats.
   */
  const smartSyncChats = useCallback(async (projectId?: string) => {
    if (!isCloudSyncEnabled()) {
      logInfo('Cloud sync is disabled, skipping smart sync', {
        component: 'useCloudSync',
        action: 'smartSyncChats',
        metadata: { projectId },
      })
      return { uploaded: 0, downloaded: 0, errors: [] }
    }

    if (syncingRef.current) {
      logInfo('Smart sync request blocked - sync already in progress', {
        component: 'useCloudSync',
        action: 'smartSyncChats',
        metadata: { projectId },
      })
      return { uploaded: 0, downloaded: 0, errors: [] }
    }

    syncingRef.current = true
    if (isMountedRef.current) {
      setState((prev) => ({ ...prev, syncing: true }))
    }

    try {
      const result = await cloudSync.smartSync(projectId)

      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          syncing: false,
          lastSyncTime: Date.now(),
        }))
      }

      if (result.uploaded > 0 || result.downloaded > 0) {
        logInfo(
          `Smart sync completed: uploaded=${result.uploaded}, downloaded=${result.downloaded}`,
          {
            component: 'useCloudSync',
            action: 'smartSyncChats',
            metadata: { projectId, result },
          },
        )
      }

      return result
    } catch (error) {
      if (isMountedRef.current) {
        setState((prev) => ({ ...prev, syncing: false }))
      }
      throw error
    } finally {
      syncingRef.current = false
    }
  }, [])

  const backupChat = useCallback(async (chatId: string) => {
    await cloudSync.backupChat(chatId)
  }, [])

  // Sync chats for a specific project (full sync)
  const syncProjectChats = useCallback(async (projectId: string) => {
    if (!isCloudSyncEnabled()) {
      logInfo('Cloud sync is disabled, skipping project chat sync', {
        component: 'useCloudSync',
        action: 'syncProjectChats',
      })
      return { uploaded: 0, downloaded: 0, errors: [] }
    }

    if (syncingRef.current) {
      logInfo('Sync request blocked - sync already in progress', {
        component: 'useCloudSync',
        action: 'syncProjectChats',
      })
      return { uploaded: 0, downloaded: 0, errors: [] }
    }

    syncingRef.current = true
    if (isMountedRef.current) {
      setState((prev) => ({ ...prev, syncing: true }))
    }

    try {
      const result = await cloudSync.syncProjectChats(projectId)

      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          syncing: false,
          lastSyncTime: Date.now(),
        }))
      }

      if (result.downloaded > 0) {
        logInfo(
          `Project chat sync completed: downloaded=${result.downloaded}`,
          {
            component: 'useCloudSync',
            action: 'syncProjectChats',
            metadata: { projectId, result },
          },
        )
      }

      return result
    } catch (error) {
      if (isMountedRef.current) {
        setState((prev) => ({ ...prev, syncing: false }))
      }
      throw error
    } finally {
      syncingRef.current = false
    }
  }, [])

  const retryDecryptionWithNewKey = useCallback(
    (opts?: { runInBackground?: boolean }) => {
      const { runInBackground = false } = opts || {}

      if (runInBackground) {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            decryptionProgress: { isDecrypting: true, current: 0, total: 0 },
          }))
        }

        const promise = cloudSync.retryDecryptionWithNewKey({
          onProgress: (current, total) => {
            if (isMountedRef.current) {
              setState((prev) => ({
                ...prev,
                decryptionProgress: { isDecrypting: true, current, total },
              }))
            }
          },
        })

        promise.finally(() => {
          if (isMountedRef.current) {
            setState((prev) => ({ ...prev, decryptionProgress: null }))
          }
        })

        promise.catch((error) => {
          logError('Background decryption failed', error, {
            component: 'useCloudSync',
            action: 'retryDecryptionWithNewKey',
          })
        })

        return promise
      }

      return cloudSync.retryDecryptionWithNewKey()
    },
    [],
  )

  const rollbackToPreviousKeys = useCallback(
    async (previousKeys: {
      primary: string | null
      alternatives: string[]
    }) => {
      try {
        await encryptionService.replaceKeyBundle(
          previousKeys.primary,
          previousKeys.alternatives,
        )
      } catch (rollbackError) {
        encryptionService.clearKey()
        clearCloudKeyAuthorization()
        throw rollbackError
      }
    },
    [],
  )

  // Set encryption key (for syncing across devices)
  const setEncryptionKey = useCallback(
    async (key: string, options?: { mode?: CloudKeyActivationMode }) => {
      const mode = options?.mode ?? 'recoverExisting'
      let previousKeys: {
        primary: string | null
        alternatives: string[]
      } | null = null
      let didSetKey = false
      let rolledBack = false
      try {
        previousKeys = encryptionService.getAllKeys()
        // Check both encryptionService (source of truth for the crypto layer) and
        // React state (source of truth for the hook). The passkey init effect may
        // have already persisted the key to encryptionService before the consumer
        // calls setEncryptionKey, so encryptionService.getKey() would match — but
        // the hook's encryptionKey state is still null and needs a sync + decrypt.
        const serviceKey = encryptionService.getKey()
        let stateKey: string | null = null
        setState((prev) => {
          stateKey = prev.encryptionKey
          return prev
        })

        await encryptionService.setKey(key)
        didSetKey = true

        if (mode === 'recoverExisting') {
          let validation: Awaited<ReturnType<typeof validateCurrentPrimaryKey>>
          try {
            validation = await validateCurrentPrimaryKey()
          } catch (validationError) {
            await rollbackToPreviousKeys(previousKeys)
            rolledBack = true
            throw validationError
          }
          if (!validation.canWrite) {
            await rollbackToPreviousKeys(previousKeys)
            rolledBack = true
            throw new Error(
              validation.message ??
                "This key doesn't match your existing cloud data.",
            )
          }
          await authorizeCurrentPrimaryKeyOrThrow('validated')
        } else {
          try {
            await authorizeCurrentPrimaryKeyOrThrow('explicit_start_fresh')
          } catch (authorizationError) {
            await rollbackToPreviousKeys(previousKeys)
            rolledBack = true
            throw authorizationError
          }
        }

        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            encryptionKey: encryptionService.getKey(),
          }))
        }

        const keyValueChanged = !serviceKey || serviceKey !== key
        const stateNeedsSync = !stateKey

        if (keyValueChanged || stateNeedsSync) {
          // Sync immediately to fetch encrypted chats from cloud
          // Don't let sync failures block key updates
          try {
            await syncChats()
          } catch (syncError) {
            logError('Failed to sync after setting encryption key', syncError, {
              component: 'useCloudSync',
              action: 'setEncryptionKey.initialSync',
            })
          }

          // Run decryption in background to avoid UI hang
          void retryDecryptionWithNewKey({
            runInBackground: true,
          })

          // Re-encrypt the passkey backup only when the key VALUE actually changed
          // (not when state is merely catching up to what encryptionService already holds,
          // e.g. after passkey auto-recovery which sets the key via encryptionService
          // before this function is called).
          if (keyValueChanged && hasPasskeyBackup()) {
            onKeyChangedRef.current?.()
          }

          return true // Always return true to trigger reload
        }

        return false // Key didn't change
      } catch (error) {
        if (didSetKey && previousKeys && !rolledBack) {
          try {
            await rollbackToPreviousKeys(previousKeys)
          } catch (rollbackError) {
            logError(
              'Failed to rollback encryption key after setEncryptionKey error',
              rollbackError,
              {
                component: 'useCloudSync',
                action: 'setEncryptionKey.rollback',
              },
            )
          }
        }
        logError('Failed to set encryption key', error, {
          component: 'useCloudSync',
          action: 'setEncryptionKey',
        })
        throw new Error(
          error instanceof Error ? error.message : 'Invalid encryption key',
        )
      }
    },
    [rollbackToPreviousKeys, syncChats, retryDecryptionWithNewKey],
  )

  const addRecoveryKey = useCallback(
    async (key: string) => {
      try {
        encryptionService.addDecryptionKey(key)
        void retryDecryptionWithNewKey({
          runInBackground: true,
        })

        if (hasPasskeyBackup()) {
          onKeyChangedRef.current?.()
        }
      } catch (error) {
        logError('Failed to add recovery key', error, {
          component: 'useCloudSync',
          action: 'addRecoveryKey',
        })
        throw new Error('Invalid encryption key')
      }
    },
    [retryDecryptionWithNewKey],
  )

  return {
    ...state,
    syncChats,
    smartSyncChats,
    syncProjectChats,
    backupChat,
    setEncryptionKey,
    addRecoveryKey,
    retryDecryptionWithNewKey,
  }
}
