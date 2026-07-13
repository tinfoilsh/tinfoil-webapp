import { CLOUD_SYNC } from '@/config'
import {
  SYNC_PROFILE_CHANGED_AT,
  SYNC_PROFILE_DIRTY,
} from '@/constants/storage-keys'
import { getCurrentCloudKeyAuthorizationMode } from '@/services/cloud/cloud-key-authorization'
import { nextClock, type EditClock } from '@/services/cloud/edit-clock'
import {
  changedProfileFields,
  isProfilePopulated,
  mergeProfilesThreeWay,
} from '@/services/cloud/profile-merge'
import {
  applySettingsToLocal,
  hasProfileChanged,
  loadLocalSettings,
} from '@/services/cloud/profile-settings-serializer'
import { profileSync, type ProfileData } from '@/services/cloud/profile-sync'
import {
  invalidateProfileSyncGeneration,
  runSerializedProfileSync,
} from '@/services/cloud/profile-sync-coordinator'
import {
  loadLocalProfileMetadata,
  loadProfileBaseline,
  saveLocalProfileMetadata,
  saveProfileBaseline,
} from '@/services/cloud/profile-sync-state'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useRef, useState } from 'react'

function clocksEqual(a?: EditClock, b?: EditClock): boolean {
  return a?.v === b?.v && a?.w === b?.w
}

function normalizeRemoteBaseline(profile: ProfileData): ProfileData {
  if (profile.isDarkMode !== undefined || !profile.themeMode) {
    return profile
  }
  const isDarkMode =
    profile.themeMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : profile.themeMode === 'dark'
  return { ...profile, isDarkMode }
}

export function useProfileSync() {
  const { isSignedIn, userId } = useAuth()
  const initializedUserId = useRef<string | null>(null)
  const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isApplyingRemoteProfile = useRef(false)
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(isCloudSyncEnabled())

  const hasLocalProfileChanges = useCallback(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(SYNC_PROFILE_DIRTY) === 'true'
  }, [])

  const markLocalProfileChanged = useCallback(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem(SYNC_PROFILE_DIRTY, 'true')
    if (!localStorage.getItem(SYNC_PROFILE_CHANGED_AT)) {
      localStorage.setItem(SYNC_PROFILE_CHANGED_AT, new Date().toISOString())
    }
  }, [])

  const clearLocalProfileChanged = useCallback(() => {
    if (typeof window === 'undefined') return
    localStorage.removeItem(SYNC_PROFILE_DIRTY)
    localStorage.removeItem(SYNC_PROFILE_CHANGED_AT)
  }, [])

  const getLocalProfileChangedAt = useCallback((): string | undefined => {
    if (typeof window === 'undefined') return undefined
    const stored = localStorage.getItem(SYNC_PROFILE_CHANGED_AT)
    return stored && !Number.isNaN(new Date(stored).getTime())
      ? stored
      : undefined
  }, [])

  const applyProfile = useCallback((profile: ProfileData) => {
    isApplyingRemoteProfile.current = true
    try {
      applySettingsToLocal(profile)
    } finally {
      isApplyingRemoteProfile.current = false
    }
  }, [])

  const prepareLocalProfile = useCallback(
    (accountId: string, baseline: ProfileData | null): ProfileData => {
      const storedMetadata = loadLocalProfileMetadata(accountId)
      const local: ProfileData = {
        ...loadLocalSettings(),
        version: baseline?.version ?? storedMetadata?.version ?? 0,
        updatedAt: getLocalProfileChangedAt(),
        fieldClocks:
          storedMetadata?.fieldClocks ?? baseline?.fieldClocks ?? undefined,
        clockVersion:
          storedMetadata?.clockVersion ?? baseline?.clockVersion ?? undefined,
      }
      const changedFields = changedProfileFields(local, baseline)
      const fieldClocks = { ...(local.fieldClocks ?? {}) }
      const unstampedFields = changedFields.filter((field) =>
        clocksEqual(fieldClocks[field], baseline?.fieldClocks?.[field]),
      )
      if (unstampedFields.length > 0) {
        const tick = nextClock()
        for (const field of unstampedFields) {
          fieldClocks[field] = tick
        }
      }
      local.fieldClocks =
        Object.keys(fieldClocks).length > 0 ? fieldClocks : undefined
      local.clockVersion = baseline?.version ?? local.version
      saveLocalProfileMetadata(accountId, local)
      return local
    },
    [getLocalProfileChangedAt],
  )

  const runFullSync = useCallback(async () => {
    if (!isSignedIn || !userId || !isCloudSyncEnabled()) return

    await runSerializedProfileSync(userId, async (isCurrent) => {
      if (!isCurrent() || !isCloudSyncEnabled()) return

      try {
        const authorizationMode = await getCurrentCloudKeyAuthorizationMode()
        if (!isCurrent() || !authorizationMode) return

        let baseline = loadProfileBaseline(userId)
        const storedMetadata = loadLocalProfileMetadata(userId)
        const local = hasLocalProfileChanges()
          ? prepareLocalProfile(userId, baseline)
          : {
              ...loadLocalSettings(),
              version: storedMetadata?.version,
              updatedAt: storedMetadata?.updatedAt,
              fieldClocks: storedMetadata?.fieldClocks,
              clockVersion: storedMetadata?.clockVersion,
            }

        const remote = await profileSync.fetchProfile()
        if (!isCurrent()) return

        if (remote) {
          const remoteBaseline = normalizeRemoteBaseline(remote)
          if (baseline) {
            const merge = mergeProfilesThreeWay({
              baseline,
              local,
              remote: remoteBaseline,
            })
            if (merge.conflicts.length > 0) {
              throw new Error(
                `Profile changes conflict on fields: ${merge.conflicts.join(', ')}`,
              )
            }
            applyProfile(merge.merged)
            saveLocalProfileMetadata(userId, merge.merged)
            saveProfileBaseline(userId, remoteBaseline)
            baseline = remoteBaseline
            if (hasProfileChanged(merge.merged, remoteBaseline)) {
              markLocalProfileChanged()
            } else {
              clearLocalProfileChanged()
            }
          } else if (hasLocalProfileChanges()) {
            throw new Error(
              'Profile has unsynced changes but no safe merge baseline.',
            )
          } else {
            applyProfile(remoteBaseline)
            saveLocalProfileMetadata(userId, remoteBaseline)
            saveProfileBaseline(userId, remoteBaseline)
            baseline = remoteBaseline
            clearLocalProfileChanged()
          }
        } else {
          const remoteStatus = await profileSync.getSyncStatus()
          if (!isCurrent()) return
          if (
            remoteStatus?.deleted &&
            isProfilePopulated(loadLocalSettings())
          ) {
            markLocalProfileChanged()
          }
        }

        if (!hasLocalProfileChanges()) {
          logInfo('Profile sync completed with no local changes', {
            component: 'ProfileSync',
            action: 'runFullSync',
          })
          return
        }

        if (
          profileSync.hasFailedRemoteDecryption() &&
          authorizationMode !== 'explicit_start_fresh'
        ) {
          return
        }

        const profileToPush = prepareLocalProfile(userId, baseline)
        if (baseline && !hasProfileChanged(profileToPush, baseline)) {
          clearLocalProfileChanged()
          return
        }

        const result = await profileSync.saveProfile(profileToPush, baseline)
        if (!isCurrent() || !result.success) return

        const savedVersion = result.version ?? profileToPush.version ?? 0
        let savedProfile: ProfileData = {
          ...(result.remoteProfile ?? profileToPush),
          version: savedVersion,
          clockVersion: savedVersion,
        }

        if (result.remoteProfile) {
          const current = prepareLocalProfile(userId, profileToPush)
          const postSaveMerge = mergeProfilesThreeWay({
            baseline: profileToPush,
            local: current,
            remote: savedProfile,
          })
          savedProfile = {
            ...savedProfile,
            version: savedVersion,
            clockVersion: savedVersion,
          }
          applyProfile(postSaveMerge.merged)
          saveLocalProfileMetadata(userId, postSaveMerge.merged)
        } else {
          saveLocalProfileMetadata(userId, {
            ...loadLocalSettings(),
            fieldClocks: savedProfile.fieldClocks,
            version: savedVersion,
            clockVersion: savedVersion,
          })
        }

        saveProfileBaseline(userId, savedProfile)
        if (hasProfileChanged(loadLocalSettings(), savedProfile)) {
          markLocalProfileChanged()
        } else {
          clearLocalProfileChanged()
        }

        logInfo('Profile synced to cloud', {
          component: 'ProfileSync',
          action: 'runFullSync',
          metadata: {
            version: savedVersion,
            adoptedRemote: !!result.remoteProfile,
          },
        })
      } catch (error) {
        if (isCurrent()) {
          logError('Failed to synchronize profile', error, {
            component: 'ProfileSync',
            action: 'runFullSync',
          })
        }
      }
    })
  }, [
    applyProfile,
    clearLocalProfileChanged,
    hasLocalProfileChanges,
    isSignedIn,
    markLocalProfileChanged,
    prepareLocalProfile,
    userId,
  ])

  const syncToCloud = useCallback(async () => {
    if (syncDebounceTimer.current) {
      clearTimeout(syncDebounceTimer.current)
    }
    syncDebounceTimer.current = setTimeout(() => {
      void runFullSync()
    }, CLOUD_SYNC.PROFILE_SYNC_DEBOUNCE)
  }, [runFullSync])

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

  useEffect(() => {
    if (!isSignedIn || !userId || !cloudSyncEnabled) {
      initializedUserId.current = null
      invalidateProfileSyncGeneration()
      return
    }

    if (initializedUserId.current !== userId) {
      initializedUserId.current = userId
      void runFullSync()
    }

    const interval = setInterval(() => {
      void runFullSync()
    }, CLOUD_SYNC.PROFILE_SYNC_INTERVAL)

    return () => {
      clearInterval(interval)
      invalidateProfileSyncGeneration()
    }
  }, [cloudSyncEnabled, isSignedIn, runFullSync, userId])

  useEffect(() => {
    if (!isSignedIn) return

    const handleSettingsChange = () => {
      if (isApplyingRemoteProfile.current) return
      markLocalProfileChanged()
      void syncToCloud()
    }
    const events = [
      'themeChanged',
      'personalizationChanged',
      'languageChanged',
      'customSystemPromptChanged',
      'promptLibraryChanged',
      'reasoningSettingsChanged',
      'webSearchEnabledChanged',
      'codeExecutionEnabledChanged',
      'piiCheckEnabledChanged',
      'genUIEnabledChanged',
      'chatFontChanged',
      'projectUploadPreferenceChanged',
    ]
    events.forEach((event) =>
      window.addEventListener(event, handleSettingsChange),
    )
    return () => {
      events.forEach((event) =>
        window.removeEventListener(event, handleSettingsChange),
      )
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current)
      }
    }
  }, [isSignedIn, markLocalProfileChanged, syncToCloud])

  return {
    syncFromCloud: runFullSync,
    smartSyncFromCloud: runFullSync,
    syncToCloud,
    retryDecryption: runFullSync,
  }
}
