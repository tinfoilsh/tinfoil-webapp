import { logError, logInfo } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import {
  pull as enclavePull,
  push as enclavePush,
  newIdempotencyKey,
  pullItemPlaintext,
} from '../sync-enclave/sync-api'
import {
  pullKeysFromEncryptionService,
  requirePrimaryKeyB64,
} from './cek-encoding'
import type { ProfileSyncStatus } from './cloud-storage'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

const PROFILE_SCOPE = 'profile'
const PROFILE_ROW_ID = 'profile'

export interface ProfileData {
  // Theme settings
  isDarkMode?: boolean
  themeMode?: 'light' | 'dark' | 'system'

  // Chat settings
  maxPromptMessages?: number
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

  // Metadata
  version?: number
  updatedAt?: string
}

export class ProfileSyncService {
  private cachedProfile: ProfileData | null = null
  private failedDecryptionData: string | null = null

  private async getHeaders(): Promise<Record<string, string>> {
    return authTokenManager.getAuthHeaders()
  }

  async isAuthenticated(): Promise<boolean> {
    return authTokenManager.isAuthenticated()
  }

  async fetchEncryptedProfilePayload(): Promise<string | null> {
    if (!(await this.isAuthenticated())) {
      return null
    }

    const response = await fetch(`${API_BASE_URL}/api/profile/`, {
      headers: await this.getHeaders(),
    })

    if (response.status === 401 || response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch profile: ${response.statusText}`)
    }

    const data = await response.json()
    return data.data as string
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

      const keys = pullKeysFromEncryptionService()
      if (keys.length === 0) return null

      const resp = await enclavePull({
        scope: PROFILE_SCOPE,
        ids: [PROFILE_ROW_ID],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        return null
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) return null

      const decoded = JSON.parse(
        new TextDecoder().decode(plaintextBytes),
      ) as ProfileData

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

      return null
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

      // Add metadata
      const profileWithMetadata: ProfileData = {
        ...profile,
        updatedAt: new Date().toISOString(),
        version: (profile.version || 0) + 1,
      }

      const plaintext = new TextEncoder().encode(
        JSON.stringify(profileWithMetadata),
      )

      await enclavePush({
        scope: PROFILE_SCOPE,
        id: PROFILE_ROW_ID,
        keyB64: requirePrimaryKeyB64(),
        plaintext,
        ifMatch: null,
        idempotencyKey: newIdempotencyKey(),
        metadata: {
          version: profileWithMetadata.version,
        },
      })

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

      const response = await fetch(`${API_BASE_URL}/api/profile/sync-status`, {
        headers: await this.getHeaders(),
      })

      if (response.status === 401) {
        return null
      }

      if (response.status === 404) {
        return { exists: false }
      }

      if (!response.ok) {
        throw new Error(
          `Failed to get profile sync status: ${response.statusText}`,
        )
      }

      return await response.json()
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
