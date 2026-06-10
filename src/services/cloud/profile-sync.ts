import { logError, logInfo } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import { encryptionService } from '../encryption/encryption-service'
import type { ProfileSyncStatus } from './cloud-storage'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

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

  async fetchProfile(): Promise<ProfileData | null> {
    try {
      const payload = await this.fetchEncryptedProfilePayload()
      if (!payload) {
        logInfo('Skipping profile fetch - not authenticated', {
          component: 'ProfileSync',
          action: 'fetchProfile',
        })
        return null
      }

      try {
        const encrypted = JSON.parse(payload)
        const decrypted = await encryptionService.decrypt(encrypted)

        this.cachedProfile = decrypted
        this.failedDecryptionData = null

        logInfo('Profile fetched and decrypted successfully', {
          component: 'ProfileSync',
          action: 'fetchProfile',
          metadata: {
            version: decrypted.version,
            hasNickname: !!decrypted.nickname,
            hasLanguage: !!decrypted.language,
            hasPersonalization: !!decrypted.isUsingPersonalization,
          },
        })

        return decrypted
      } catch (decryptError) {
        // Failed to decrypt - store for later retry
        this.failedDecryptionData = payload
        this.cachedProfile = null

        logInfo('Profile decryption failed, stored for retry', {
          component: 'ProfileSync',
          action: 'fetchProfile',
          metadata: {
            error:
              decryptError instanceof Error
                ? decryptError.message
                : 'Unknown error',
          },
        })

        return null
      }
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

      const profileWithMetadata: ProfileData = {
        ...profile,
        updatedAt: new Date().toISOString(),
        version: (profile.version || 0) + 1,
      }

      const encrypted = await encryptionService.encrypt(profileWithMetadata)

      logInfo('Encrypted profile data', {
        component: 'ProfileSync',
        action: 'saveProfile',
        metadata: {
          hasIv: !!encrypted.iv,
          hasData: !!encrypted.data,
          ivLength: encrypted.iv?.length || 0,
          dataLength: encrypted.data?.length || 0,
          stringifiedLength: JSON.stringify(encrypted).length,
        },
      })

      const response = await fetch(`${API_BASE_URL}/api/profile/`, {
        method: 'PUT',
        headers: await this.getHeaders(),
        body: JSON.stringify({
          data: JSON.stringify(encrypted),
        }),
      })

      if (response.status === 401) {
        return { success: false }
      }

      if (!response.ok) {
        throw new Error(`Failed to save profile: ${response.statusText}`)
      }

      this.cachedProfile = profileWithMetadata

      logInfo('Profile saved successfully', {
        component: 'ProfileSync',
        action: 'saveProfile',
        metadata: {
          version: profileWithMetadata.version,
          size: JSON.stringify(encrypted).length,
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

  async retryDecryptionWithNewKey(): Promise<ProfileData | null> {
    if (!this.failedDecryptionData) {
      return null
    }

    try {
      const encrypted = JSON.parse(this.failedDecryptionData)
      const decrypted = await encryptionService.decrypt(encrypted)

      this.cachedProfile = decrypted
      this.failedDecryptionData = null

      logInfo('Profile decrypted successfully with new key', {
        component: 'ProfileSync',
        action: 'retryDecryptionWithNewKey',
      })

      return decrypted
    } catch (error) {
      logInfo('Profile decryption with new key failed', {
        component: 'ProfileSync',
        action: 'retryDecryptionWithNewKey',
      })

      return null
    }
  }

  // Get cached profile (for quick access)
  getCachedProfile(): ProfileData | null {
    return this.cachedProfile
  }

  hasFailedRemoteDecryption(): boolean {
    return this.failedDecryptionData !== null
  }

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
