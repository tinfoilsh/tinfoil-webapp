import {
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import {
  authorizeCurrentPrimaryKeyOrThrow,
  canWriteToCloud,
  clearCloudKeyAuthorization,
  registerStartFreshKeyIfNeeded,
} from '@/services/cloud/cloud-key-authorization'
import {
  CloudKeySetupError,
  validateCurrentPrimaryKey,
} from '@/services/cloud/cloud-key-preflight'
import { cloudSync, type SyncResult } from '@/services/cloud/cloud-sync'
import { reportSyncSuccess } from '@/services/cloud/sync-health'
import { encryptionService } from '@/services/encryption/encryption-service'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  isCloudSyncEnabled,
  setCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { hasPasskeyBackup } from '@/utils/signout-cleanup'
import { useAuth } from '@clerk/react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface CloudSyncState {
  syncing: boolean
  lastSyncTime: number | null
  lastSyncFailed: boolean
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
    lastSyncFailed: false,
    encryptionKey: null,
    initialized: false,
    decryptionProgress: null,
  })
  const syncingRef = useRef(false)
  const syncPromiseRef = useRef<Promise<SyncResult> | null>(null)
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

  const runChatSync = useCallback((projectId?: string) => {
    syncingRef.current = true
    if (isMountedRef.current) {
      setState((prev) => ({ ...prev, syncing: true }))
    }

    const syncPromise = (async () => {
      try {
        const result = await cloudSync.smartSync(projectId)
        const syncFailed = result.errors.length > 0

        if (!syncFailed) {
          reportSyncSuccess()
        }

        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            syncing: false,
            lastSyncTime: Date.now(),
            lastSyncFailed: syncFailed,
          }))
        }

        logInfo(
          `Sync completed: uploaded=${result.uploaded}, downloaded=${result.downloaded}`,
          {
            component: 'useCloudSync',
            action: 'syncChats',
            metadata: { projectId, result },
          },
        )
        return result
      } catch (error) {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            syncing: false,
            lastSyncFailed: true,
          }))
        }
        throw error
      } finally {
        syncingRef.current = false
        syncPromiseRef.current = null
      }
    })()
    syncPromiseRef.current = syncPromise
    return syncPromise
  }, [])

  const getOrRunChatSync = useCallback(
    (projectId?: string) => syncPromiseRef.current ?? runChatSync(projectId),
    [runChatSync],
  )

  const syncChats = useCallback(async () => {
    if (!isCloudSyncEnabled()) {
      logInfo('Cloud sync is disabled, skipping sync', {
        component: 'useCloudSync',
        action: 'syncChats',
      })
      return false
    }
    return getOrRunChatSync()
  }, [getOrRunChatSync])

  /**
   * Smart sync: checks sync status first and only syncs if changes detected.
   * @param projectId - Optional project ID. If provided, syncs project chats.
   */
  const smartSyncChats = useCallback(
    async (projectId?: string) => {
      if (!isCloudSyncEnabled()) {
        logInfo('Cloud sync is disabled, skipping smart sync', {
          component: 'useCloudSync',
          action: 'smartSyncChats',
          metadata: { projectId },
        })
        return { uploaded: 0, downloaded: 0, errors: [] }
      }

      return getOrRunChatSync(projectId)
    },
    [getOrRunChatSync],
  )

  const backupChat = useCallback(async (chatId: string) => {
    await cloudSync.backupChat(chatId)
  }, [])

  // Sync chats for a specific project (full sync)
  const syncProjectChats = useCallback(
    async (projectId: string) => {
      if (!isCloudSyncEnabled()) {
        logInfo('Cloud sync is disabled, skipping project chat sync', {
          component: 'useCloudSync',
          action: 'syncProjectChats',
        })
        return { uploaded: 0, downloaded: 0, errors: [] }
      }

      return getOrRunChatSync(projectId)
    },
    [getOrRunChatSync],
  )

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
      // Set when the new key must be kept despite a thrown error
      // (start_fresh already wiped the cloud under the new key, so
      // rolling back would strand the account on a key that matches
      // nothing server-side).
      let keepNewKeyOnError = false
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

        // Stage the key in memory only. The enclave handshake below
        // reads the active CEK from the service, so it operates on this
        // key without committing it to storage. We persist only after
        // the enclave accepts it, so an interrupted activation can never
        // strand a local-only key the enclave would reject.
        await encryptionService.setKey(key, { persist: false })
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
            throw new CloudKeySetupError(
              validation.message ??
                "This key doesn't match your existing cloud data.",
              validation.remoteState,
            )
          }
          await authorizeCurrentPrimaryKeyOrThrow('validated')
        } else {
          try {
            await registerStartFreshKeyIfNeeded()
            await authorizeCurrentPrimaryKeyOrThrow('explicit_start_fresh')
          } catch (authorizationError) {
            await rollbackToPreviousKeys(previousKeys)
            rolledBack = true
            throw authorizationError
          }
          // The cloud is wiped and the new key registered — from here
          // on the old key is unusable, so no error may roll back.
          keepNewKeyOnError = true
          // §H4 — `start_fresh` wipes the cloud, so any local
          // `syncVersion` numbers no longer match a row anywhere.
          // Reset them all so the next push goes up as a fresh
          // create instead of failing the next ETag CAS in a forever
          // 409 loop.
          try {
            await indexedDBStorage.resetSyncMetadataForAllChats()
            await cloudSync.clearSyncStatusAfterServerWipe()
          } catch (resetError) {
            logError(
              'Failed to reset local sync metadata after start_fresh',
              resetError,
              {
                component: 'useCloudSync',
                action: 'setEncryptionKey.resetSyncMetadata',
              },
            )
            throw resetError
          }
        }

        // The enclave has accepted the key — commit it to storage now.
        encryptionService.persistCurrentKeyState()

        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            encryptionKey: encryptionService.getKey(),
          }))
        }

        const keyValueChanged = !serviceKey || serviceKey !== key
        const stateNeedsSync = !stateKey

        if (keyValueChanged || stateNeedsSync) {
          // Pull encrypted chats from the cloud and decrypt them in the
          // background so callers (e.g. the passkey recovery modal) can
          // dismiss as soon as the key is authorized, instead of blocking
          // the whole UI until every chat is decrypted. The sidebar shows
          // a "Loading chats" indicator driven by `decryptionProgress`
          // until the decryption pass finishes.
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              decryptionProgress: { isDecrypting: true, current: 0, total: 0 },
            }))
          }
          void (async () => {
            try {
              await syncChats()
            } catch (syncError) {
              logError(
                'Failed to sync after setting encryption key',
                syncError,
                {
                  component: 'useCloudSync',
                  action: 'setEncryptionKey.initialSync',
                },
              )
            }
            // Run decryption in background to avoid UI hang
            await retryDecryptionWithNewKey({ runInBackground: true }).catch(
              () => {},
            )
          })()

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
        if (keepNewKeyOnError) {
          // Commit the accepted key and re-encrypt the passkey backup
          // so a partial start_fresh failure (e.g. the local metadata
          // reset) leaves the account on a fully usable new key. Any
          // chats with stale syncVersions will surface CAS conflicts
          // in the sync UI, where re-uploading resolves them — worse
          // than a clean reset, but recoverable; a rolled-back key
          // would not be.
          encryptionService.persistCurrentKeyState()
          // Keep the hook state in step with the persisted key so the
          // settings UI and passkey hook don't keep serving the old one.
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              encryptionKey: encryptionService.getKey(),
            }))
          }
          if (hasPasskeyBackup()) {
            onKeyChangedRef.current?.()
          }
        } else if (didSetKey && previousKeys && !rolledBack) {
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
        // Preserve CloudKeySetupError so callers can tell a genuine key
        // mismatch / verification outage apart from a malformed key.
        // Flattening to a plain Error here makes every failure look like
        // an "invalid key" to classifyCloudKeySetupError.
        if (error instanceof CloudKeySetupError) {
          throw error
        }
        throw new Error(
          error instanceof Error ? error.message : 'Invalid encryption key',
        )
      }
    },
    [rollbackToPreviousKeys, syncChats, retryDecryptionWithNewKey],
  )

  return {
    ...state,
    syncChats,
    smartSyncChats,
    syncProjectChats,
    backupChat,
    setEncryptionKey,
    retryDecryptionWithNewKey,
  }
}
