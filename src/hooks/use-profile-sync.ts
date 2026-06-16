import { CLOUD_SYNC } from '@/config'
import {
  SYNC_PROFILE_CHANGED_AT,
  SYNC_PROFILE_DIRTY,
  SYNC_PROFILE_STATUS,
} from '@/constants/storage-keys'
import { getCurrentCloudKeyAuthorizationMode } from '@/services/cloud/cloud-key-authorization'
import type { ProfileSyncStatus } from '@/services/cloud/cloud-storage'
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

    if (hasLocalProfileChanges()) {
      logInfo('Skipping cloud sync - local changes pending', {
        component: 'ProfileSync',
        action: 'syncFromCloud',
      })
      return
    }

    try {
      const cloudProfile = await profileSync.fetchProfile()

      if (cloudProfile) {
        const cloudVersion = cloudProfile.version || 0

        // Re-check pending changes after fetch to avoid race with local edits
        if (hasLocalProfileChanges()) {
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
          lastSyncedProfile.current = cloudProfile

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
            isApplyingRemoteProfile.current = true
            try {
              const defaults = resetSettingsToLocalDefaults()
              clearLocalProfileChanged()
              lastSyncedVersion.current = 0
              lastSyncedProfile.current = defaults
              profileSync.clearCache()
              profileSyncCache.current.save(remoteStatus)
            } finally {
              isApplyingRemoteProfile.current = false
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
          lastSyncedProfile.current = cloudProfile
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
  }, [clearLocalProfileChanged, hasLocalProfileChanges, isSignedIn])

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

        // Include the last synced version so the service can increment
        // it, plus the edit time so conflict resolution can arbitrate
        // last-write-wins against the remote.
        const profileWithVersion = {
          ...localSettings,
          version: lastSyncedVersion.current,
          updatedAt: getLocalProfileChangedAt(),
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
            lastSyncedProfile.current = result.remoteProfile
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
        syncToCloud()
      } else {
        // Initial sync on page load - this will also set lastSyncedVersion
        syncFromCloud().then(() => {
          // After initial sync, get the current cloud version and profile
          const cachedProfile = profileSync.getCachedProfile()
          if (cachedProfile) {
            if (cachedProfile.version) {
              lastSyncedVersion.current = cachedProfile.version
            }
            lastSyncedProfile.current = cachedProfile
          }
        })
      }
    }

    // Use smart sync at regular intervals to reduce bandwidth
    const interval = setInterval(() => {
      if (hasLocalProfileChanges()) {
        syncToCloud()
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
      lastSyncedProfile.current = decryptedProfile
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
