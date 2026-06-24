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
import { observe } from './edit-clock'
import { mergeProfiles } from './profile-merge'
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
  genUIEnabled?: boolean
  chatFont?: 'system' | 'serif' | 'mono' | 'dyslexic'
  projectUploadPreference?: 'project' | 'chat'

  // Metadata
  version?: number
  updatedAt?: string

  // Per-field edit clocks and the row version they were last
  // maintained at. fieldClocks is trusted for the field-level merge
  // only when clockVersion equals the profile row's server etag
  // (version); otherwise a clock-unaware write intervened and merge
  // falls back to updatedAt arbitration.
  fieldClocks?: Record<string, { v: number; w: string }>
  clockVersion?: number
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

      // Advance the local logical clock past every remote field clock
      // so a later local edit is guaranteed to outrank what we observed.
      if (decoded.fieldClocks) {
        for (const clock of Object.values(decoded.fieldClocks)) {
          observe(typeof clock?.v === 'number' ? clock.v : null)
        }
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

      // The working copy that gets pushed. On a conflict it is replaced
      // by the field-level merge of local and remote before re-push.
      let working: ProfileData = profile

      // Push the local profile under a given base version. The
      // controlplane treats a missing/zero version as create-only and
      // any positive version as a CAS update gated on the row's etag.
      const pushAtVersion = async (
        baseVersion: number,
      ): Promise<{ success: boolean; version?: number }> => {
        const profileWithMetadata: ProfileData = {
          ...working,
          // Preserve the caller's edit time so other devices can
          // arbitrate last-write-wins; only stamp now when absent.
          updatedAt: working.updatedAt ?? new Date().toISOString(),
          version: baseVersion + 1,
          // The field clocks are current as of the version this push
          // creates, so a remote reader trusts them (etag ===
          // clockVersion) instead of falling back to updatedAt.
          clockVersion: baseVersion + 1,
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
        return await pushAtVersion(profile.version || 0)
      } catch (pushError) {
        if (!isStaleBlobConflict(pushError)) {
          throw pushError
        }
        // Optimistic-concurrency conflict: the server holds a version
        // our push was not based on. Re-read it and merge field by
        // field so neither device's edits are lost, then re-push the
        // merged result onto the server's current version.
        logInfo('Profile push conflicted; merging fields', {
          component: 'ProfileSync',
          action: 'saveProfile',
        })
        const remote = await this.fetchProfile()

        if (!remote) {
          // The remote vanished between the conflict and our re-read;
          // re-push local as a fresh create.
          return await pushAtVersion(0)
        }

        const { merged, adoptedRemote } = mergeProfiles({
          local: profile,
          remote,
        })
        working = merged

        logInfo('Profile conflict resolved by field-level merge', {
          component: 'ProfileSync',
          action: 'saveProfile',
          metadata: { adoptedRemote },
        })

        const pushed = await pushAtVersion(remote.version ?? 0)
        // Hand the merged profile back so the caller applies any fields
        // adopted from the remote and both devices converge.
        return adoptedRemote
          ? {
              success: pushed.success,
              version: pushed.version,
              remoteProfile: this.cachedProfile ?? merged,
            }
          : pushed
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
