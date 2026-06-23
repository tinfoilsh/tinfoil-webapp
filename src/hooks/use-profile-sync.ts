import { CLOUD_SYNC } from '@/config'
import {
  SYNC_PROFILE_CHANGED_AT,
  SYNC_PROFILE_DIRTY,
  SYNC_PROFILE_STATUS,
} from '@/constants/storage-keys'
import { getCurrentCloudKeyAuthorizationMode } from '@/services/cloud/cloud-key-authorization'
import type { ProfileSyncStatus } from '@/services/cloud/cloud-storage'
import { nextClock, type EditClock } from '@/services/cloud/edit-clock'
import {
  changedProfileFields,
  isProfilePopulated,
} from '@/services/cloud/profile-merge'
import {
  applySettingsToLocal,
  hasProfileChanged,
  loadLocalSettings,
  resetSettingsToLocalDefaults,
} from '@/services/cloud/profile-settings-serializer'
import { profileSync, type ProfileData } from '@/services/cloud/profile-sync'
import { SyncStatusCache } from '@/services/cloud/sync-status-cache'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useRef, useState } from 'react'

const PROFILE_SYNC_STATUS_KEY = SYNC_PROFILE_STATUS

export function useProfileSync() {
  const { isSignedIn } = useAuth()
  const hasInitialized = useRef(false)
  const syncDebounceTimer = useRef<NodeJS.Timeout | null>(null)
  const lastSyncedVersion = useRef<number>(0)
  const hasPendingChanges = useRef(false)
  const isApplyingRemoteProfile = useRef(false)
  const lastSyncedProfile = useRef<ProfileData | null>(null)
  // Field clocks last seen/pushed, carried forward so unchanged fields
  // keep their clock across cycles when the fetched cache is empty.
  const lastFieldClocks = useRef<Record<string, EditClock>>({})
  const profileSyncCache = useRef(
    new SyncStatusCache<ProfileSyncStatus>(PROFILE_SYNC_STATUS_KEY),
  )
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(isCloudSyncEnabled())

  const hasLocalProfileChanges = useCallback(() => {
    if (hasPendingChanges.current) return true
    if (typeof window === 'undefined') return false
    return localStorage.getItem(SYNC_PROFILE_DIRTY) === 'true'
  }, [])

  const markLocalProfileChanged = useCallback(() => {
    hasPendingChanges.current = true
    if (typeof window !== 'undefined') {
      localStorage.setItem(SYNC_PROFILE_DIRTY, 'true')
      localStorage.setItem(SYNC_PROFILE_CHANGED_AT, new Date().toISOString())
    }
  }, [])

  const clearLocalProfileChanged = useCallback(() => {
    hasPendingChanges.current = false
    if (typeof window !== 'undefined') {
      localStorage.removeItem(SYNC_PROFILE_DIRTY)
      localStorage.removeItem(SYNC_PROFILE_CHANGED_AT)
    }
  }, [])

  // Edit time of the pending local profile change, used to arbitrate
  // last-write-wins against the remote. Returns undefined when the edit
  // time is unknown (e.g. a dirty flag left by an older build, or
  // partially cleared storage) so unknown-age local data cannot win the
  // arbitration and clobber a genuinely newer remote: conflict
  // resolution then defers to the remote, while a non-conflicting push
  // still stamps the current time.
  const getLocalProfileChangedAt = useCallback((): string | undefined => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(SYNC_PROFILE_CHANGED_AT)
      if (stored && !Number.isNaN(new Date(stored).getTime())) {
        return stored
      }
    }
    return undefined
  }, [])

  // Listen for cloud sync setting changes
  useEffect(() => {
    const checkCloudSyncStatus = () => {
      setCloudSyncEnabled(isCloudSyncEnabled())
    }

    checkCloudSyncStatus()

    window.addEventListener('storage', checkCloudSyncStatus)
    window.addEventListener('cloudSyncSettingChanged', checkCloudSyncStatus)

    return () => {
      window.removeEventListener('storage', checkCloudSyncStatus)
      window.removeEventListener(
        'cloudSyncSettingChanged',
        checkCloudSyncStatus,
      )
    }
  }, [])

  // Sync profile from cloud to local
  const syncFromCloud = useCallback(async () => {
    if (!isSignedIn || !isCloudSyncEnabled()) return

    try {
      const cloudProfile = await profileSync.fetchProfile()

      if (cloudProfile) {
        const cloudVersion = cloudProfile.version || 0

        // A pending local edit must not be overwritten by the remote,
        // but we still record the server's current version so the
        // pending push rebases onto it as a CAS update instead of
        // looping on a create-at-zero that would block every future
        // pull behind a never-clearing dirty flag. Last-write-wins on
        // push decides the winner.
        if (hasLocalProfileChanges()) {
          if (cloudVersion > lastSyncedVersion.current) {
            lastSyncedVersion.current = cloudVersion
          }
          return
        }

        // Ignore stale cloud versions to prevent overwriting newer local state
        if (cloudVersion < lastSyncedVersion.current) {
          return
        }

        if (hasProfileChanged(cloudProfile, lastSyncedProfile.current)) {
          isApplyingRemoteProfile.current = true
          try {
            applySettingsToLocal(cloudProfile)
          } finally {
            isApplyingRemoteProfile.current = false
          }
          clearLocalProfileChanged()
          lastSyncedVersion.current = cloudVersion
          // Baseline must mirror what loadLocalSettings would
          // re-serialize, not the raw remote: the remote may omit
          // fields this client derives (e.g. themeMode from isDarkMode),
          // which would otherwise read back as a phantom local change
          // and wedge every future pull behind a never-clearing dirty
          // flag while looping STALE_BLOB pushes.
          lastSyncedProfile.current = loadLocalSettings()
          lastFieldClocks.current = cloudProfile.fieldClocks ?? {}

          logInfo('Profile synced from cloud', {
            component: 'ProfileSync',
            action: 'syncFromCloud',
            metadata: { version: cloudVersion },
          })
        } else {
          logInfo('Cloud profile unchanged', {
            component: 'ProfileSync',
            action: 'syncFromCloud',
          })
        }
      }
    } catch (error) {
      logError('Failed to sync profile from cloud', error, {
        component: 'ProfileSync',
        action: 'syncFromCloud',
      })
    }
  }, [clearLocalProfileChanged, hasLocalProfileChanges, isSignedIn])

  // Smart sync: check sync status first and only fetch profile if changed
  const smartSyncFromCloud = useCallback(async () => {
    if (!isSignedIn || !isCloudSyncEnabled()) return

    if (hasLocalProfileChanges()) {
      return
    }

    try {
      const remoteStatus = await profileSync.getSyncStatus()

      if (!remoteStatus) {
        return
      }

      if (!remoteStatus.exists) {
        if (remoteStatus.deleted) {
          const cached = profileSyncCache.current.load()
          const needsReset =
            !cached ||
            cached.exists ||
            cached.lastUpdated !== remoteStatus.lastUpdated

          if (needsReset && !hasLocalProfileChanges()) {
            const localSettings = loadLocalSettings()
            if (isProfilePopulated(localSettings)) {
              // A profile tombstone must never silently wipe a populated
              // local profile. Resurrect it by re-pushing local as a
              // fresh create instead of resetting to defaults.
              logInfo('Profile tombstone ignored; resurrecting local profile', {
                component: 'ProfileSync',
                action: 'smartSyncFromCloud',
              })
              lastSyncedVersion.current = 0
              profileSync.clearCache()
              profileSyncCache.current.save(remoteStatus)
              // Flag the local edit; the sync interval then pushes it as
              // a create on the next tick.
              markLocalProfileChanged()
            } else {
              // No user content to lose; accept the reset to defaults.
              isApplyingRemoteProfile.current = true
              try {
                const defaults = resetSettingsToLocalDefaults()
                clearLocalProfileChanged()
                lastSyncedVersion.current = 0
                lastSyncedProfile.current = defaults
                lastFieldClocks.current = {}
                profileSync.clearCache()
                profileSyncCache.current.save(remoteStatus)
              } finally {
                isApplyingRemoteProfile.current = false
              }
            }
          }
        }
        return
      }

      const cached = profileSyncCache.current.load()

      const needsSync =
        !cached ||
        !cached.exists ||
        cached.version !== remoteStatus.version ||
        cached.lastUpdated !== remoteStatus.lastUpdated

      if (!needsSync) {
        logInfo('Smart profile sync: no changes detected', {
          component: 'ProfileSync',
          action: 'smartSyncFromCloud',
          metadata: { version: remoteStatus.version },
        })
        return
      }

      logInfo('Smart profile sync: changes detected, fetching profile', {
        component: 'ProfileSync',
        action: 'smartSyncFromCloud',
        metadata: {
          cachedVersion: cached?.version,
          remoteVersion: remoteStatus.version,
        },
      })

      // Fetch the full profile since it changed
      const cloudProfile = await profileSync.fetchProfile()

      if (cloudProfile) {
        const cloudVersion = cloudProfile.version || 0

        // Re-check pending changes after fetch
        if (hasLocalProfileChanges()) {
          return
        }

        // Ignore stale versions
        if (cloudVersion < lastSyncedVersion.current) {
          return
        }

        if (hasProfileChanged(cloudProfile, lastSyncedProfile.current)) {
          isApplyingRemoteProfile.current = true
          try {
            applySettingsToLocal(cloudProfile)
          } finally {
            isApplyingRemoteProfile.current = false
          }
          clearLocalProfileChanged()
          lastSyncedVersion.current = cloudVersion
          // Baseline must mirror what loadLocalSettings would
          // re-serialize, not the raw remote: the remote may omit
          // fields this client derives (e.g. themeMode from isDarkMode),
          // which would otherwise read back as a phantom local change
          // and wedge every future pull behind a never-clearing dirty
          // flag while looping STALE_BLOB pushes.
          lastSyncedProfile.current = loadLocalSettings()
          lastFieldClocks.current = cloudProfile.fieldClocks ?? {}
        }

        // Update cached sync status only after successful processing
        profileSyncCache.current.save(remoteStatus)
      }
    } catch (error) {
      logError('Failed smart profile sync', error, {
        component: 'ProfileSync',
        action: 'smartSyncFromCloud',
      })
    }
  }, [
    clearLocalProfileChanged,
    hasLocalProfileChanges,
    markLocalProfileChanged,
    isSignedIn,
  ])

  // Sync profile from local to cloud (debounced)
  const syncToCloud = useCallback(async () => {
    if (!isSignedIn || !isCloudSyncEnabled()) return

    if (syncDebounceTimer.current) {
      clearTimeout(syncDebounceTimer.current)
    }

    // Debounce the sync to avoid too many API calls
    syncDebounceTimer.current = setTimeout(async () => {
      if (!isCloudSyncEnabled()) return

      try {
        const authorizationMode = await getCurrentCloudKeyAuthorizationMode()
        if (!authorizationMode) {
          return
        }

        if (
          profileSync.hasFailedRemoteDecryption() &&
          authorizationMode !== 'explicit_start_fresh'
        ) {
          return
        }

        const localSettings = loadLocalSettings()

        if (!hasProfileChanged(localSettings, lastSyncedProfile.current)) {
          logInfo('Skipping cloud sync - no changes detected', {
            component: 'ProfileSync',
            action: 'syncToCloud',
          })
          clearLocalProfileChanged()
          return
        }

        // Mark that we have pending changes only when we're actually going to sync
        hasPendingChanges.current = true

        // Stamp a fresh edit clock on every field that changed since the
        // last sync, carrying forward the existing clocks for the rest.
        // One tick covers this push because it is a single local write
        // event; the deviceId tiebreak keeps it ordered against peers.
        const baseClocks =
          profileSync.getCachedProfile()?.fieldClocks ?? lastFieldClocks.current
        const changedFields = changedProfileFields(
          localSettings,
          lastSyncedProfile.current,
        )
        const fieldClocks: Record<string, EditClock> = { ...baseClocks }
        if (changedFields.length > 0) {
          const tick = nextClock()
          for (const field of changedFields) {
            fieldClocks[field] = tick
          }
        }
        lastFieldClocks.current = fieldClocks

        // Include the last synced version so the service can increment
        // it, plus the edit time so conflict resolution can arbitrate
        // last-write-wins against the remote when a clock is absent.
        const profileWithVersion = {
          ...localSettings,
          version: lastSyncedVersion.current,
          updatedAt: getLocalProfileChangedAt(),
          fieldClocks,
        }

        const result = await profileSync.saveProfile(profileWithVersion)

        if (result.success) {
          // Use the actual version returned from the service
          if (result.version !== undefined) {
            lastSyncedVersion.current = result.version
          }

          if (result.remoteProfile) {
            // A concurrently-updated device won the last-write race;
            // adopt its settings locally so both devices converge
            // instead of keeping our now-stale edit.
            isApplyingRemoteProfile.current = true
            try {
              applySettingsToLocal(result.remoteProfile)
            } finally {
              isApplyingRemoteProfile.current = false
            }
            // Adopt the round-tripped local snapshot, not the raw
            // remote, so fields we derive but the peer omits don't read
            // back as a phantom change and re-trigger the push loop.
            lastSyncedProfile.current = loadLocalSettings()
            lastFieldClocks.current = result.remoteProfile.fieldClocks ?? {}
          } else {
            lastSyncedProfile.current = localSettings
          }
          clearLocalProfileChanged()

          logInfo('Profile synced to cloud', {
            component: 'ProfileSync',
            action: 'syncToCloud',
            metadata: {
              version: lastSyncedVersion.current,
              adoptedRemote: !!result.remoteProfile,
            },
          })
        }
      } catch (error) {
        logError('Failed to sync profile to cloud', error, {
          component: 'ProfileSync',
          action: 'syncToCloud',
        })
      }
    }, 2000) // 2 second debounce
  }, [clearLocalProfileChanged, getLocalProfileChangedAt, isSignedIn])

  // Initial sync when authenticated and periodic sync (only if cloud sync is enabled)
  useEffect(() => {
    if (!isSignedIn || !cloudSyncEnabled) {
      hasInitialized.current = false
      lastSyncedVersion.current = 0
      lastSyncedProfile.current = null
      profileSyncCache.current.clear()
      profileSync.clearCache()
      clearLocalProfileChanged()
      return
    }

    if (!hasInitialized.current) {
      hasInitialized.current = true
      logInfo('Initializing profile sync', {
        component: 'useProfileSync',
        action: 'initialize',
      })
      if (hasLocalProfileChanges()) {
        // A pending edit exists. Learn the server version first (without
        // overwriting the edit) so the push is a CAS update rather than a
        // create that could loop on STALE_BLOB, then push.
        syncFromCloud().then(() => syncToCloud())
      } else {
        // Initial sync on page load - this will also set lastSyncedVersion
        syncFromCloud().then(() => {
          // After initial sync, get the current cloud version and profile
          const cachedProfile = profileSync.getCachedProfile()
          if (cachedProfile) {
            if (cachedProfile.version) {
              lastSyncedVersion.current = cachedProfile.version
            }
            // If a local edit landed while the initial pull was in
            // flight, syncFromCloud skipped applying it. Keep the remote
            // as the baseline so the pending change is still detected and
            // pushed; only baseline from the round-tripped local snapshot
            // when there is no pending edit to preserve.
            lastSyncedProfile.current = hasLocalProfileChanges()
              ? cachedProfile
              : loadLocalSettings()
          }
        })
      }
    }

    // Use smart sync at regular intervals to reduce bandwidth
    const interval = setInterval(() => {
      if (hasLocalProfileChanges()) {
        if (lastSyncedVersion.current === 0) {
          // Never established a base version; learn it first so the push
          // is a CAS update instead of a create that can loop on
          // STALE_BLOB and block all future pulls.
          syncFromCloud().then(() => syncToCloud())
        } else {
          syncToCloud()
        }
      } else {
        smartSyncFromCloud()
      }
    }, CLOUD_SYNC.PROFILE_SYNC_INTERVAL)

    return () => clearInterval(interval)
  }, [
    clearLocalProfileChanged,
    hasLocalProfileChanges,
    isSignedIn,
    cloudSyncEnabled,
    syncFromCloud,
    smartSyncFromCloud,
    syncToCloud,
  ])

  // Listen for settings changes and sync to cloud
  useEffect(() => {
    if (!isSignedIn) return

    const handleSettingsChange = () => {
      if (isApplyingRemoteProfile.current) {
        return
      }
      // Immediately mark as pending to prevent cloud overwrites during debounce
      markLocalProfileChanged()
      syncToCloud()
    }

    const events = [
      'themeChanged',
      'personalizationChanged',
      'languageChanged',
      'customSystemPromptChanged',
      'promptLibraryChanged',
      'selectedModelChanged',
      'reasoningSettingsChanged',
      'webSearchEnabledChanged',
      'codeExecutionEnabledChanged',
      'piiCheckEnabledChanged',
      'chatFontChanged',
      'projectUploadPreferenceChanged',
    ]

    events.forEach((event) => {
      window.addEventListener(event, handleSettingsChange)
    })

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, handleSettingsChange)
      })

      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current)
      }
    }
  }, [isSignedIn, markLocalProfileChanged, syncToCloud])

  // Retry decryption when encryption key changes
  const retryDecryption = useCallback(async () => {
    const decryptedProfile = await profileSync.retryDecryptionWithNewKey()
    if (decryptedProfile) {
      isApplyingRemoteProfile.current = true
      try {
        applySettingsToLocal(decryptedProfile)
      } finally {
        isApplyingRemoteProfile.current = false
      }
      clearLocalProfileChanged()
      // Update the synced version and profile after successful decryption
      if (decryptedProfile.version) {
        lastSyncedVersion.current = decryptedProfile.version
      }
      lastSyncedProfile.current = loadLocalSettings()
      logInfo('Profile decrypted and applied with new key', {
        component: 'ProfileSync',
        action: 'retryDecryption',
        metadata: {
          version: decryptedProfile.version,
        },
      })
    }
  }, [clearLocalProfileChanged])

  return {
    syncFromCloud,
    smartSyncFromCloud,
    syncToCloud,
    retryDecryption,
  }
}
