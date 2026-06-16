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
import { remoteWinsLastWrite } from './sync-predicates'

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

// Top-level keys this client models. The profile is a single
// full-replace blob shared across clients, so anything else in a
// fetched profile belongs to a newer or other-platform client (e.g. an
// iOS-only setting) and must survive our next push rather than being
// dropped when we re-serialize only the keys we know about.
const KNOWN_PROFILE_KEYS = new Set<string>(Object.keys(ProfileDataSchema.shape))

function extractUnknownProfileFields(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (!KNOWN_PROFILE_KEYS.has(key)) {
      extra[key] = source[key]
    }
  }
  return extra
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
  // Fields from the last fetched profile that this client does not
  // model, carried forward on every push so we never wipe settings
  // owned by another client.
  private unknownRemoteFields: Record<string, unknown> = {}

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
        if (item && item.code === 'NOT_FOUND') {
          this.unknownRemoteFields = {}
          return null
        }
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
      this.unknownRemoteFields = extractUnknownProfileFields(
        validation.data as Record<string, unknown>,
      )
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
  async saveProfile(profile: ProfileData): Promise<{
    success: boolean
    version?: number
    remoteProfile?: ProfileData
  }> {
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
          // Preserve the caller's edit time so other devices can
          // arbitrate last-write-wins; only stamp now when absent.
          updatedAt: profile.updatedAt ?? new Date().toISOString(),
          version: baseVersion + 1,
        }

        // Carry forward fields we do not model under our own known
        // fields, so a push never drops settings owned by another
        // client. Known fields always win the merge.
        const payload = { ...this.unknownRemoteFields, ...profileWithMetadata }
        const plaintext = new TextEncoder().encode(JSON.stringify(payload))
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
        // DEBUG[profile-sync]: remove before merge.
        console.log('[profile-sync] saveProfile push', {
          baseVersion: profile.version || 0,
          updatedAt: profile.updatedAt,
        })
        return await pushAtVersion(profile.version || 0)
      } catch (pushError) {
        if (!isStaleBlobConflict(pushError)) {
          // DEBUG[profile-sync]: remove before merge.
          console.log('[profile-sync] saveProfile push failed (non-conflict)', {
            error: pushError instanceof Error ? pushError.message : pushError,
          })
          throw pushError
        }
        // Optimistic-concurrency conflict: the server holds a version
        // our push was not based on. Re-read it and arbitrate
        // last-write-wins by content modification time.
        logInfo('Profile push conflicted; arbitrating last-write-wins', {
          component: 'ProfileSync',
          action: 'saveProfile',
        })
        const remote = await this.fetchProfile()

        // DEBUG[profile-sync]: remove before merge.
        console.log('[profile-sync] saveProfile conflict (STALE_BLOB)', {
          localUpdatedAt: profile.updatedAt,
          remoteUpdatedAt: remote?.updatedAt,
          remoteVersion: remote?.version,
          remoteWins:
            !!remote &&
            remoteWinsLastWrite(profile.updatedAt, remote.updatedAt),
        })

        if (
          remote &&
          remoteWinsLastWrite(profile.updatedAt, remote.updatedAt)
        ) {
          // The remote is the strictly newer write. Adopt it instead of
          // clobbering, and hand it back so the caller can apply it
          // locally; both devices then converge on the same settings.
          logInfo('Profile conflict resolved by adopting newer remote', {
            component: 'ProfileSync',
            action: 'saveProfile',
          })
          this.cachedProfile = remote
          return {
            success: true,
            version: remote.version,
            remoteProfile: remote,
          }
        }

        // Our local edit is the last write. Rebase onto the server's
        // current version and re-push so local wins instead of looping
        // on STALE_BLOB forever.
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
    this.unknownRemoteFields = {}
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
