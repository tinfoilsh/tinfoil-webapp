import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import {
  listStatus as enclaveListStatus,
  pull as enclavePull,
  push as enclavePush,
  newIdempotencyKey,
  pullItemPlaintext,
} from '../sync-enclave/sync-api'
import { SyncEnclaveError } from '../sync-enclave/sync-enclave-client'
import { WIRE_CODES } from '../sync-enclave/wire-contract'
import { pullKey, requirePrimaryKeyB64 } from './cek-encoding'
import type { ProfileSyncStatus } from './cloud-storage'
import { ProfileDataSchema } from './schemas'

const PROFILE_SCOPE = 'profile'
const PROFILE_ROW_ID = 'profile'

// A STALE_BLOB (HTTP 412) push means our If-Match version no longer
// matches the server: either the row advanced under another writer or
// we tried to create a profile that already exists.
function isStaleBlobConflict(error: unknown): boolean {
  return (
    error instanceof SyncEnclaveError &&
    (error.code === WIRE_CODES.StaleBlob || error.status === 412)
  )
}

export interface ProfileData {
  // Theme settings
  isDarkMode?: boolean
  themeMode?: 'light' | 'dark' | 'system'

  // Chat settings
  language?: string

  // Personalization settings
  nickname?: string
  profession?: string
  traits?: string[]
  additionalContext?: string
  isUsingPersonalization?: boolean

  // Custom system prompt settings
  isUsingCustomPrompt?: boolean
  customSystemPrompt?: string
  customPromptPresets?: ProfilePromptPreset[]
  // Ordered preset ids pinned as homescreen favorites (built-in or custom)
  favoritePromptPresetIds?: string[]

  // Shared chat defaults
  selectedModel?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  thinkingEnabled?: boolean
  webSearchEnabled?: boolean
  codeExecutionEnabled?: boolean
  piiCheckEnabled?: boolean
  chatFont?: 'system' | 'serif' | 'mono' | 'dyslexic'
  projectUploadPreference?: 'project' | 'chat'

  // Metadata
  version?: number
  updatedAt?: string
}

export interface ProfilePromptPreset {
  id: string
  name: string
  description: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export class ProfileSyncService {
  private cachedProfile: ProfileData | null = null
  private failedDecryptionData: string | null = null

  async isAuthenticated(): Promise<boolean> {
    return authTokenManager.isAuthenticated()
  }

  // Get profile from cloud via the sync enclave. The enclave unseals
  // the row server-side and returns plaintext, so there is no
  // client-side decryption step.
  async fetchProfile(): Promise<ProfileData | null> {
    try {
      if (!(await this.isAuthenticated())) {
        logInfo('Skipping profile fetch - not authenticated', {
          component: 'ProfileSync',
          action: 'fetchProfile',
        })
        return null
      }

      const keys = pullKey()
      if (keys.length === 0) return null

      const resp = await enclavePull({
        scope: PROFILE_SCOPE,
        ids: [PROFILE_ROW_ID],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        throw new Error(
          item?.code || 'Failed to pull profile from sync enclave',
        )
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) return null

      const validation = ProfileDataSchema.safeParse(
        JSON.parse(new TextDecoder().decode(plaintextBytes)),
      )
      if (!validation.success) {
        logWarning('Discarding profile with invalid shape from enclave', {
          component: 'ProfileSync',
          action: 'fetchProfile',
          metadata: { issues: validation.error.message },
        })
        return null
      }
      const decoded = validation.data as ProfileData
      const etagVersion = item.etag ? parseInt(item.etag, 10) : NaN
      if (Number.isFinite(etagVersion)) {
        decoded.version = etagVersion
      }

      this.cachedProfile = decoded
      this.failedDecryptionData = null

      logInfo('Profile fetched via enclave', {
        component: 'ProfileSync',
        action: 'fetchProfile',
        metadata: {
          version: decoded.version,
          hasNickname: !!decoded.nickname,
          hasLanguage: !!decoded.language,
          hasPersonalization: !!decoded.isUsingPersonalization,
        },
      })

      return decoded
    } catch (error) {
      // Silently fail if no auth token
      if (
        error instanceof Error &&
        error.message.includes('Authentication token not set')
      ) {
        logInfo('Profile fetch skipped - no auth token', {
          component: 'ProfileSync',
          action: 'fetchProfile',
        })
        return null
      }

      logError('Failed to fetch profile', error, {
        component: 'ProfileSync',
        action: 'fetchProfile',
      })

      throw error
    }
  }

  // Save profile to cloud
  async saveProfile(
    profile: ProfileData,
  ): Promise<{ success: boolean; version?: number }> {
    try {
      if (!(await this.isAuthenticated())) {
        logInfo('Skipping profile save - not authenticated', {
          component: 'ProfileSync',
          action: 'saveProfile',
        })
        return { success: false }
      }

      logInfo('Saving profile to cloud', {
        component: 'ProfileSync',
        action: 'saveProfile',
        metadata: {
          hasNickname: !!profile.nickname,
          hasLanguage: !!profile.language,
          hasPersonalization: !!profile.isUsingPersonalization,
        },
      })

      // Push the local profile under a given base version. The
      // controlplane treats a missing/zero version as create-only and
      // any positive version as a CAS update gated on the row's etag.
      const pushAtVersion = async (
        baseVersion: number,
      ): Promise<{ success: boolean; version?: number }> => {
        const profileWithMetadata: ProfileData = {
          ...profile,
          updatedAt: new Date().toISOString(),
          version: baseVersion + 1,
        }

        const plaintext = new TextEncoder().encode(
          JSON.stringify(profileWithMetadata),
        )
        const ifMatch = baseVersion > 0 ? String(baseVersion) : null

        const pushResp = await enclavePush({
          scope: PROFILE_SCOPE,
          id: PROFILE_ROW_ID,
          keyB64: requirePrimaryKeyB64(),
          plaintext,
          ifMatch,
          idempotencyKey: newIdempotencyKey(),
          metadata: {
            version: profileWithMetadata.version,
          },
        })
        const pushedVersion = parseInt(pushResp.etag, 10)
        if (Number.isFinite(pushedVersion)) {
          profileWithMetadata.version = pushedVersion
        }

        // Update cache
        this.cachedProfile = profileWithMetadata

        logInfo('Profile saved via enclave', {
          component: 'ProfileSync',
          action: 'saveProfile',
          metadata: {
            version: profileWithMetadata.version,
            size: plaintext.byteLength,
          },
        })

        return { success: true, version: profileWithMetadata.version }
      }

      try {
        return await pushAtVersion(profile.version || 0)
      } catch (pushError) {
        if (!isStaleBlobConflict(pushError)) {
          throw pushError
        }
        // Optimistic-concurrency conflict: our base version is behind
        // the server, or we tried to create a profile that already
        // exists. Re-read the current version and retry once so local
        // settings win instead of looping on STALE_BLOB forever.
        logInfo('Profile push conflicted; rebasing on current version', {
          component: 'ProfileSync',
          action: 'saveProfile',
        })
        const remote = await this.fetchProfile()
        return await pushAtVersion(remote?.version ?? 0)
      }
    } catch (error) {
      // Silently fail if no auth token
      if (
        error instanceof Error &&
        error.message.includes('Authentication token not set')
      ) {
        logInfo('Profile save skipped - no auth token', {
          component: 'ProfileSync',
          action: 'saveProfile',
        })
        return { success: false }
      }

      logError('Failed to save profile', error, {
        component: 'ProfileSync',
        action: 'saveProfile',
      })

      return { success: false }
    }
  }

  // Retry decryption with the now-current key. With the sync enclave
  // the enclave already tries every key the client supplied on each
  // pull, so a retry is just another pull through the standard path.
  async retryDecryptionWithNewKey(): Promise<ProfileData | null> {
    if (!this.failedDecryptionData) {
      return null
    }

    const refreshed = await this.fetchProfile()
    if (refreshed) {
      logInfo('Profile re-fetched successfully with new key', {
        component: 'ProfileSync',
        action: 'retryDecryptionWithNewKey',
      })
    }
    return refreshed
  }

  // Get cached profile (for quick access)
  getCachedProfile(): ProfileData | null {
    return this.cachedProfile
  }

  hasFailedRemoteDecryption(): boolean {
    return this.failedDecryptionData !== null
  }

  // Clear cache
  clearCache(): void {
    this.cachedProfile = null
    this.failedDecryptionData = null
  }

  // Get sync status to check if profile changed without fetching full data
  async getSyncStatus(): Promise<ProfileSyncStatus | null> {
    try {
      if (!(await this.isAuthenticated())) {
        return null
      }

      const status = await enclaveListStatus({ scope: PROFILE_SCOPE })
      const current = status.updates.find((u) => u.id === PROFILE_ROW_ID)
      const deleted = status.deletes.find(
        (d) => d.scope === PROFILE_SCOPE && d.id === PROFILE_ROW_ID,
      )
      if (!current) {
        return {
          exists: false,
          deleted: !!deleted,
          lastUpdated: deleted?.deleted_at,
        }
      }
      const version = parseInt(current.etag, 10)
      return {
        exists: true,
        version: Number.isFinite(version) ? version : undefined,
        lastUpdated: current.updated_at,
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('Authentication token not set')
      ) {
        return null
      }

      logError('Failed to get profile sync status', error, {
        component: 'ProfileSync',
        action: 'getSyncStatus',
      })

      return null
    }
  }
}

export const profileSync = new ProfileSyncService()
