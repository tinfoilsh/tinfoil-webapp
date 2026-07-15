import {
  PASSKEY_BUNDLE_VERSION,
  PASSKEY_SYNC_VERSION,
  SECRET_PASSKEY_BACKED_UP,
  SETTINGS_BACKUP_WARNING_DISMISSED,
  SETTINGS_MANUAL_RECOVERY_DISMISSED,
  SETTINGS_PASSKEY_FIRST_TIME_PROMPT_DISMISSED,
  SETTINGS_PASSKEY_RECOVERY_DISMISSED,
  SETTINGS_PASSKEY_SETUP_WARNING_DISMISSED,
} from '@/constants/storage-keys'
import type { CloudKeyAuthorizationMode } from '@/services/cloud/cloud-key-authorization'
import {
  authorizeCurrentPrimaryKeyOrThrow,
  getCurrentCloudKeyAuthorizationMode,
} from '@/services/cloud/cloud-key-authorization'
import {
  inspectRemoteEncryptedState,
  validateCurrentPrimaryKey,
} from '@/services/cloud/cloud-key-preflight'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  authenticatePrfPasskey,
  createPrfPasskey,
  decryptKeyBundle,
  deletePasskeyCredential,
  deriveKeyEncryptionKey,
  getCachedPrfResult,
  getLocalPasskeyCredentialId,
  getPasskeyCredentialState,
  getPasskeyDeviceState,
  loadPasskeyCredentials,
  loadRecoveryCandidates,
  PasskeyCredentialConflictError,
  PasskeyTimeoutError,
  PrfNotSupportedError,
  retrieveEncryptedKeys,
  storeEncryptedKeys,
} from '@/services/passkey'
import { isPrfSupported } from '@/services/passkey/prf-support'
import { cekBytesToHex } from '@/services/sync-enclave/key-bundle'
import { passkeyEvents } from '@/services/sync-enclave/passkey-events'
import {
  addBundleForCurrentKey,
  promoteRecoveredCekToEnclave,
} from '@/services/sync-enclave/passkey-key-flow'
import { keyCurrent as enclaveKeyCurrent } from '@/services/sync-enclave/sync-api'
import { setCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import type { useUser } from '@clerk/nextjs'
import { useCallback, useEffect, useRef, useState } from 'react'

type UserResource = NonNullable<ReturnType<typeof useUser>['user']>

export interface PasskeyBackupState {
  /** Passkey backup exists on the backend or was used/stored this session */
  passkeyActive: boolean
  /** Backend has passkey credentials but auth failed on this device */
  passkeyRecoveryNeeded: boolean
  /** Remote encrypted data exists but this device needs a manual recovery key */
  manualRecoveryNeeded: boolean
  /** PRF supported + keys exist locally; user can register a passkey backup from settings */
  passkeySetupAvailable: boolean
  /**
   * Local CEK already has bundle(s) on the server, but none of them
   * belong to this device's last-known credential id. Surfaces a
   * "Set Up Passkey on This Device" prompt so the user can enroll a
   * second authenticator (e.g. Windows Hello after already having an
   * Apple passkey on another device). The data model already supports
   * many bundles per key — this flag exposes that capability in the UI.
   */
  passkeyAddDeviceAvailable: boolean
  /**
   * Passkey backup setup was attempted but failed because the user's passkey
   * provider doesn't actually support PRF or hung. Surfaces the
   * "your chats are not backed up" warning modal.
   */
  passkeySetupFailed: boolean
  /**
   * Whether retrying the passkey flow makes sense given the current state.
   * False when the warning was raised by a path where there is no passkey
   * credential to retry against (e.g. remote data exists but the server
   * has no registered passkey for this user). The warning modal hides the
   * "Try Again with Passkey" button in that case.
   */
  passkeyRetryAvailable: boolean
  /**
   * First-time user with no local key, no remote backup, and PRF support
   * available. Surfaces a confirmation modal asking whether to enable
   * passkey-backed cloud sync — we no longer invoke the native passkey
   * prompt automatically on page load.
   */
  passkeyFirstTimePromptAvailable: boolean
  /** Specific passkey recovery failure to show users a useful next step. */
  passkeyRecoveryFailure: PasskeyRecoveryFailure | null
}

export type PasskeyRecoveryFailure = 'auth_failed' | 'stale_backup'

type StoredPasskeyBackup = {
  credentialId: string
  syncVersion: number
  bundleVersion: number
}

type GeneratedPasskeyKey = {
  key: string
  credentialId: string
}

type ApplyRecoveredKeyBundleResult =
  | { mode: CloudKeyAuthorizationMode }
  | { mode: null; reason: PasskeyRecoveryFailure }

export interface UsePasskeyBackupOptions {
  /** Current encryption key from useCloudSync (null if not yet set) */
  encryptionKey: string | null
  /** Whether the cloud sync init has completed */
  initialized: boolean
  isSignedIn: boolean | undefined
  user: UserResource | null | undefined
  /**
   * Called when the passkey init effect auto-recovers or auto-generates a key.
   * The consumer should feed this into setEncryptionKey so that useCloudSync
   * state stays in sync with what encryptionService now holds.
   */
  onEncryptionKeyRecovered?: (key: string) => void
}

const SYNC_CHECK_INTERVAL_MS = 30_000

/**
 * Read the locally remembered sync_version for a credential ID.
 */
function getLocalSyncVersion(credentialId: string): number | null {
  try {
    const raw = localStorage.getItem(PASSKEY_SYNC_VERSION)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, number>
    return map[credentialId] ?? null
  } catch {
    return null
  }
}

/**
 * Persist the sync_version for a credential ID so we can detect remote changes.
 */
function setLocalSyncVersion(credentialId: string, version: number): void {
  try {
    let map: Record<string, number> = {}
    const raw = localStorage.getItem(PASSKEY_SYNC_VERSION)
    if (raw) {
      map = JSON.parse(raw) as Record<string, number>
    }
    map[credentialId] = version
    localStorage.setItem(PASSKEY_SYNC_VERSION, JSON.stringify(map))
  } catch {
    // best-effort
  }
}

function getLocalBundleVersion(): number | null {
  try {
    const raw = localStorage.getItem(PASSKEY_BUNDLE_VERSION)
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function setLocalBundleVersion(version: number): void {
  try {
    localStorage.setItem(PASSKEY_BUNDLE_VERSION, String(version))
  } catch {
    // best-effort
  }
}

interface StorageFlag {
  isSet: () => boolean
  set: () => void
  clear: () => void
}

// Build a best-effort boolean flag backed by a web Storage bucket. All
// operations swallow errors so Safari ITP / quota / private-mode failures
// never crash the hook.
function createStorageFlag(
  getStorage: () => Storage,
  key: string,
): StorageFlag {
  return {
    isSet: () => {
      try {
        return getStorage().getItem(key) === 'true'
      } catch {
        return false
      }
    },
    set: () => {
      try {
        getStorage().setItem(key, 'true')
      } catch {
        // best-effort
      }
    },
    clear: () => {
      try {
        getStorage().removeItem(key)
      } catch {
        // best-effort
      }
    },
  }
}

const setupWarningDismissedFlag = createStorageFlag(
  () => sessionStorage,
  SETTINGS_PASSKEY_SETUP_WARNING_DISMISSED,
)

const passkeyRecoveryDismissedFlag = createStorageFlag(
  () => localStorage,
  SETTINGS_PASSKEY_RECOVERY_DISMISSED,
)

const firstTimePromptDismissedFlag = createStorageFlag(
  () => localStorage,
  SETTINGS_PASSKEY_FIRST_TIME_PROMPT_DISMISSED,
)

const manualRecoveryDismissedFlag = createStorageFlag(
  () => localStorage,
  SETTINGS_MANUAL_RECOVERY_DISMISSED,
)

const backupWarningDismissedFlag = createStorageFlag(
  () => localStorage,
  SETTINGS_BACKUP_WARNING_DISMISSED,
)

export function usePasskeyBackup({
  encryptionKey,
  initialized,
  isSignedIn,
  user,
  onEncryptionKeyRecovered,
}: UsePasskeyBackupOptions) {
  const [state, setState] = useState<PasskeyBackupState>({
    passkeyActive: false,
    passkeyRecoveryNeeded: false,
    manualRecoveryNeeded: false,
    passkeySetupAvailable: false,
    passkeyAddDeviceAvailable: false,
    passkeySetupFailed: false,
    passkeyRetryAvailable: true,
    passkeyFirstTimePromptAvailable: false,
    passkeyRecoveryFailure: null,
  })

  const isMountedRef = useRef(true)
  const passkeyFlowInProgressRef = useRef(false)
  const userRef = useRef(user)
  userRef.current = user
  const onEncryptionKeyRecoveredRef = useRef(onEncryptionKeyRecovered)
  onEncryptionKeyRecoveredRef.current = onEncryptionKeyRecovered
  const hasInitializedPasskeyRef = useRef(false)
  const previousUserIdRef = useRef<string | null | undefined>(undefined)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // When the signed-in user changes *after* the initial sign-in hydration
  // (sign-out-then-sign-in on the same tab, or a user switch), reset the
  // init guard and per-user state so the passkey init effect re-runs for
  // the new session. Also clear any previous-session recovery dismissal so
  // we never inherit a prior user's "don't prompt me" choice.
  //
  // The ref starts as `undefined` and is only populated once we've observed
  // a real user ID. This way, the initial Clerk hydration sequence
  // (`undefined → null → <id>` on reload, or `undefined → <id>` directly)
  // does not trip the reset and wipe legitimate same-user dismissals.
  useEffect(() => {
    const currentUserId = isSignedIn ? (user?.id ?? null) : null
    if (previousUserIdRef.current === undefined) {
      if (currentUserId !== null) {
        previousUserIdRef.current = currentUserId
      }
      return
    }
    if (currentUserId !== null && currentUserId !== previousUserIdRef.current) {
      hasInitializedPasskeyRef.current = false
      passkeyRecoveryDismissedFlag.clear()
      firstTimePromptDismissedFlag.clear()
      setupWarningDismissedFlag.clear()
      manualRecoveryDismissedFlag.clear()
      backupWarningDismissedFlag.clear()
      if (isMountedRef.current) {
        setState({
          passkeyActive: false,
          passkeyRecoveryNeeded: false,
          manualRecoveryNeeded: false,
          passkeySetupAvailable: false,
          passkeyAddDeviceAvailable: false,
          passkeySetupFailed: false,
          passkeyRetryAvailable: true,
          passkeyFirstTimePromptAvailable: false,
          passkeyRecoveryFailure: null,
        })
      }
      previousUserIdRef.current = currentUserId
    }
  }, [isSignedIn, user?.id])

  /**
   * Build the (userId, userName, displayName) tuple for createPrfPasskey
   * from the current Clerk user, or return null if no user is available.
   */
  const getPasskeyUserInfo = (): {
    userId: string
    userName: string
    displayName: string
  } | null => {
    const u = userRef.current
    if (!u) return null
    return {
      userId: u.id,
      userName: u.primaryEmailAddress?.emailAddress ?? u.id,
      displayName: u.fullName ?? u.primaryEmailAddress?.emailAddress ?? u.id,
    }
  }

  /**
   * Create a PRF passkey and encrypt the given key bundle to the backend.
   * Returns true if the passkey was created and keys stored, false if the user
   * cancelled or PRF wasn't supported, throws on unexpected errors.
   */
  const createAndStorePasskeyBackup = async (
    userInfo: { userId: string; userName: string; displayName: string },
    keys: {
      primary: string
      alternatives: string[]
      authorizationMode: CloudKeyAuthorizationMode
    },
    options?: {
      knownBundleVersion?: number | null
      incrementBundleVersion?: boolean
      enforceRemoteBundleVersion?: boolean
    },
  ): Promise<StoredPasskeyBackup | null> => {
    const passkeyResult = await createPrfPasskey(
      userInfo.userId,
      userInfo.userName,
      userInfo.displayName,
    )
    if (!passkeyResult) return null

    const kek = await deriveKeyEncryptionKey(passkeyResult.prfOutput)
    const result = await storeEncryptedKeys(
      passkeyResult.credentialId,
      kek,
      keys,
      {
        knownBundleVersion: options?.knownBundleVersion,
        incrementBundleVersion: options?.incrementBundleVersion,
        enforceRemoteBundleVersion: options?.enforceRemoteBundleVersion,
      },
    )
    if (!result) return null
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    setLocalSyncVersion(passkeyResult.credentialId, result.syncVersion)
    setLocalBundleVersion(result.bundleVersion)
    return {
      credentialId: passkeyResult.credentialId,
      syncVersion: result.syncVersion,
      bundleVersion: result.bundleVersion,
    }
  }

  /**
   * Generate a new encryption key, back it up with a new passkey, persist it,
   * and enable cloud sync. Returns the new key on success, null on cancel/failure.
   * Shared by first-time setup and "Start Fresh" flows.
   */
  const generateKeyWithPasskeyBackup = useCallback(
    async (
      authorizationMode: CloudKeyAuthorizationMode = 'validated',
      options?: {
        incrementBundleVersion?: boolean
        enforceRemoteBundleVersion?: boolean
      },
    ): Promise<GeneratedPasskeyKey | null> => {
      const userInfo = getPasskeyUserInfo()
      if (!userInfo) return null

      const newKey = await encryptionService.generateKey()

      const created = await createAndStorePasskeyBackup(
        userInfo,
        {
          primary: newKey,
          alternatives: [],
          authorizationMode,
        },
        {
          knownBundleVersion: getLocalBundleVersion(),
          incrementBundleVersion: options?.incrementBundleVersion,
          enforceRemoteBundleVersion: options?.enforceRemoteBundleVersion,
        },
      )
      if (!created) return null

      await encryptionService.setKey(newKey)
      return { key: newKey, credentialId: created.credentialId }
    },
    [],
  )

  /**
   * Core passkey recovery: load credentials, authenticate, derive KEK, decrypt bundle.
   * Returns the recovered KeyBundle on success, null on failure/cancellation.
   * Throws on unexpected errors (callers decide how to handle).
   *
   * When the matched credential came from the legacy
   * `/api/passkey-credentials/` JSONB (rather than the enclave's
   * `user_key_bundles`), the recovered CEK is also returned along
   * with the KEK so the caller can promote it to a real `user_keys`
   * row via `promoteRecoveredCekToEnclave`. Without that promotion
   * the next session would fall back to the legacy endpoint again.
   */
  const performPasskeyRecovery = async (): Promise<{
    keyBundle: {
      primary: string
      alternatives: string[]
      authorizationMode?: CloudKeyAuthorizationMode
    }
    credentialId: string
    syncVersion: number | null
    bundleVersion: number
    legacyKek?: CryptoKey
  } | null> => {
    const entries = await loadRecoveryCandidates()
    if (entries.length === 0) return null

    const credentialIds = entries.map((e) => e.id)
    const result = await authenticatePrfPasskey(credentialIds)
    if (!result) return null

    const kek = await deriveKeyEncryptionKey(result.prfOutput)
    const keyBundle = await retrieveEncryptedKeys(result.credentialId, kek)
    if (!keyBundle) return null

    const entry = entries.find((e) => e.id === result.credentialId)
    const isLegacy = entry?.source === 'legacy'
    return {
      keyBundle,
      credentialId: result.credentialId,
      syncVersion: entry?.sync_version ?? null,
      bundleVersion: entry?.bundle_version ?? 0,
      legacyKek: isLegacy ? kek : undefined,
    }
  }

  /**
   * Apply recovered keys to component state. Shared by tryPasskeyRecovery
   * (init effect) and recoverWithPasskey (UI-triggered retry).
   */
  const applyRecoveredKeys = (recovery: {
    keyBundle: {
      primary: string
      alternatives: string[]
      authorizationMode?: CloudKeyAuthorizationMode
    }
    credentialId: string
    syncVersion: number | null
    bundleVersion: number
  }): void => {
    setCloudSyncEnabled(true)
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    if (recovery.syncVersion !== null) {
      setLocalSyncVersion(recovery.credentialId, recovery.syncVersion)
    }
    setLocalBundleVersion(recovery.bundleVersion)

    if (isMountedRef.current) {
      setState((prev) => ({
        ...prev,
        passkeyActive: true,
        passkeyRecoveryNeeded: false,
        manualRecoveryNeeded: false,
        passkeyRecoveryFailure: null,
      }))
    }
  }

  /**
   * If the recovered bundle came from the legacy
   * `/api/passkey-credentials/` JSONB (no `user_keys` row on the
   * enclave yet), promote the recovered CEK by writing a real
   * `user_keys` row + initial bundle through the enclave wire.
   * Subsequent sessions will then find the user via the new wire
   * and the legacy fallback won't trigger again.
   *
   * Failure is non-fatal — the user is already unlocked locally and
   * will simply hit the legacy fallback on the next session. The
   * structured log line surfaces the failure so we can investigate.
   */
  const maybePromoteLegacyKey = async (recovery: {
    keyBundle: { primary: string }
    credentialId: string
    legacyKek?: CryptoKey
  }): Promise<void> => {
    if (!recovery.legacyKek) return
    const cekBytes = encryptionService.getAlternativeKeyBytes(
      recovery.keyBundle.primary,
    )
    if (!cekBytes) {
      logError(
        'cannot promote legacy passkey CEK: primary key bytes unavailable',
        new Error('missing cek bytes'),
        { component: 'usePasskeyBackup', action: 'maybePromoteLegacyKey' },
      )
      return
    }
    const cekHex = cekBytesToHex(cekBytes)
    const result = await promoteRecoveredCekToEnclave({
      cekHex,
      credentialId: recovery.credentialId,
      kek: recovery.legacyKek,
    })
    if (!result.ok) {
      logError(
        'failed to promote legacy passkey credential to enclave',
        new Error(result.reason),
        {
          component: 'usePasskeyBackup',
          action: 'maybePromoteLegacyKey',
          metadata: { reason: result.reason },
        },
      )
    }
  }

  /**
   * Apply a newly generated key to component state. Shared by
   * setupFirstTimePasskeyUser (init effect) and setupNewKeySplit (UI-triggered).
   */
  const applyNewPasskeyKey = (): void => {
    setCloudSyncEnabled(true)
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')

    if (isMountedRef.current) {
      setState((prev) => ({
        ...prev,
        passkeyActive: true,
        passkeyRecoveryNeeded: false,
        manualRecoveryNeeded: false,
        passkeyRecoveryFailure: null,
      }))
    }
  }

  const rollbackToPreviousKeys = useCallback(
    async (previousKeys: {
      primary: string | null
      alternatives: string[]
    }): Promise<void> => {
      await encryptionService.replaceKeyBundle(
        previousKeys.primary,
        previousKeys.alternatives,
      )
    },
    [],
  )

  const getRecoveredAuthorizationMode = useCallback(
    (
      authorizationMode?: CloudKeyAuthorizationMode,
    ): CloudKeyAuthorizationMode =>
      authorizationMode === 'explicit_start_fresh'
        ? 'explicit_start_fresh'
        : 'validated',
    [],
  )

  const doesCurrentStateMatchBundle = useCallback(
    async (bundle: {
      primary: string
      alternatives: string[]
      authorizationMode?: CloudKeyAuthorizationMode
    }): Promise<boolean> => {
      const currentKeys = encryptionService.getAllKeys()
      if (currentKeys.primary !== bundle.primary) {
        return false
      }

      const normalizeAlternatives = (primary: string, alternatives: string[]) =>
        alternatives
          .filter((key) => key !== primary)
          .slice()
          .sort()

      const currentAlternatives = normalizeAlternatives(
        currentKeys.primary,
        currentKeys.alternatives,
      )
      const bundleAlternatives = normalizeAlternatives(
        bundle.primary,
        bundle.alternatives,
      )

      if (
        currentAlternatives.length !== bundleAlternatives.length ||
        currentAlternatives.some(
          (key, index) => key !== bundleAlternatives[index],
        )
      ) {
        return false
      }

      const currentMode = await getCurrentCloudKeyAuthorizationMode()
      return (
        currentMode === getRecoveredAuthorizationMode(bundle.authorizationMode)
      )
    },
    [getRecoveredAuthorizationMode],
  )

  const applyRecoveredKeyBundle = useCallback(
    async (
      bundle: {
        primary: string
        alternatives: string[]
        authorizationMode?: CloudKeyAuthorizationMode
      },
      previousKeys: {
        primary: string | null
        alternatives: string[]
      },
    ): Promise<ApplyRecoveredKeyBundleResult> => {
      await encryptionService.setAllKeys(bundle.primary, bundle.alternatives)

      const authorizationMode = getRecoveredAuthorizationMode(
        bundle.authorizationMode,
      )

      if (authorizationMode === 'explicit_start_fresh') {
        try {
          await authorizeCurrentPrimaryKeyOrThrow('explicit_start_fresh')
          return { mode: 'explicit_start_fresh' }
        } catch {
          await rollbackToPreviousKeys(previousKeys)
          return { mode: null, reason: 'stale_backup' }
        }
      }

      let validation: Awaited<ReturnType<typeof validateCurrentPrimaryKey>>
      try {
        validation = await validateCurrentPrimaryKey()
      } catch {
        await rollbackToPreviousKeys(previousKeys)
        return { mode: null, reason: 'auth_failed' }
      }

      if (!validation.canWrite) {
        await rollbackToPreviousKeys(previousKeys)
        return { mode: null, reason: 'stale_backup' }
      }

      try {
        await authorizeCurrentPrimaryKeyOrThrow('validated')
        return { mode: 'validated' }
      } catch {
        await rollbackToPreviousKeys(previousKeys)
        return { mode: null, reason: 'auth_failed' }
      }
    },
    [getRecoveredAuthorizationMode, rollbackToPreviousKeys],
  )

  /**
   * Re-encrypt the passkey backup with the current key bundle.
   * Called after key changes to keep the backup in sync.
   */
  const updatePasskeyBackup = useCallback(async (): Promise<void> => {
    const markBackupUpdateNeeded = (): void => {
      if (!isMountedRef.current) return
      setState((prev) => ({
        ...prev,
        passkeySetupFailed: true,
        passkeySetupAvailable: true,
        passkeyRetryAvailable: true,
      }))
    }

    try {
      const authorizationMode = await getCurrentCloudKeyAuthorizationMode()
      if (!authorizationMode) return

      const entries = await loadPasskeyCredentials()
      if (entries.length === 0) return

      // Use the cached PRF result to avoid re-prompting biometrics.
      // Falls back to a full WebAuthn authentication if no cache is available
      // or if the cached credential is no longer registered on the backend.
      const cached = getCachedPrfResult()
      const result =
        cached && entries.some((e) => e.id === cached.credentialId)
          ? cached
          : await authenticatePrfPasskey(entries.map((e) => e.id))
      if (!result) {
        markBackupUpdateNeeded()
        return
      }

      const kek = await deriveKeyEncryptionKey(result.prfOutput)
      const keys = encryptionService.getAllKeys()
      if (!keys.primary) return
      const currentEntry = entries.find((e) => e.id === result.credentialId)

      let localSyncVersion = getLocalSyncVersion(result.credentialId)
      let localBundleVersion = getLocalBundleVersion()

      if (
        (localSyncVersion === null || localBundleVersion === null) &&
        currentEntry
      ) {
        const currentRemoteBundle = await decryptKeyBundle(kek, {
          iv: currentEntry.iv,
          data: currentEntry.encrypted_keys,
        })

        if (await doesCurrentStateMatchBundle(currentRemoteBundle)) {
          localSyncVersion ??= currentEntry.sync_version
          localBundleVersion ??= currentEntry.bundle_version ?? 0
        }
      }

      const stored = await storeEncryptedKeys(
        result.credentialId,
        kek,
        {
          primary: keys.primary,
          alternatives: keys.alternatives,
          authorizationMode,
        },
        {
          expectedSyncVersion: localSyncVersion,
          knownBundleVersion: localBundleVersion,
          incrementBundleVersion: true,
          enforceRemoteBundleVersion: true,
        },
      )

      if (!stored) {
        markBackupUpdateNeeded()
        return
      }

      setLocalSyncVersion(result.credentialId, stored.syncVersion)
      setLocalBundleVersion(stored.bundleVersion)
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          passkeySetupFailed: false,
          passkeySetupAvailable: false,
          passkeyActive: true,
        }))
      }

      logInfo('Updated passkey backup after key change', {
        component: 'usePasskeyBackup',
        action: 'updatePasskeyBackup',
      })
    } catch (error) {
      if (error instanceof PasskeyCredentialConflictError) {
        logInfo(
          'Skipped passkey backup update because a newer backup already exists',
          {
            component: 'usePasskeyBackup',
            action: 'updatePasskeyBackup',
            metadata: {
              remoteSyncVersion: error.remoteSyncVersion,
              remoteBundleVersion: error.remoteBundleVersion,
            },
          },
        )
        markBackupUpdateNeeded()
        return
      }
      logError('Failed to update passkey backup after key change', error, {
        component: 'usePasskeyBackup',
        action: 'updatePasskeyBackup',
      })
      markBackupUpdateNeeded()
    }
  }, [doesCurrentStateMatchBundle])

  /**
   * Check if the passkey backup has been updated by another device (sync_version
   * changed). If so, decrypt the updated backup using the cached PRF and apply
   * the new keys locally. This avoids prompting biometrics — if no cached PRF
   * is available, the check is skipped silently.
   */
  const refreshKeyFromPasskeyBackup = useCallback(async (): Promise<void> => {
    try {
      const cached = getCachedPrfResult()
      if (!cached) return

      const entries = await loadPasskeyCredentials()
      const entry = entries.find((e) => e.id === cached.credentialId)
      if (!entry) return

      const localVersion = getLocalSyncVersion(cached.credentialId)
      if (localVersion !== null && entry.sync_version <= localVersion) return

      // sync_version increased — another device updated the backup
      const kek = await deriveKeyEncryptionKey(cached.prfOutput)
      const bundle = await decryptKeyBundle(kek, {
        iv: entry.iv,
        data: entry.encrypted_keys,
      })

      if (await doesCurrentStateMatchBundle(bundle)) {
        setLocalSyncVersion(cached.credentialId, entry.sync_version)
        if (entry.bundle_version !== undefined) {
          setLocalBundleVersion(entry.bundle_version)
        }
        return
      }

      const previousKeys = encryptionService.getAllKeys()
      const applied = await applyRecoveredKeyBundle(bundle, previousKeys)
      if (!applied.mode) {
        return
      }

      setLocalSyncVersion(cached.credentialId, entry.sync_version)
      if (entry.bundle_version !== undefined) {
        setLocalBundleVersion(entry.bundle_version)
      }
      if (bundle.primary !== previousKeys.primary) {
        onEncryptionKeyRecoveredRef.current?.(bundle.primary)
      }

      logInfo('Refreshed encryption key from passkey backup', {
        component: 'usePasskeyBackup',
        action: 'refreshKeyFromPasskeyBackup',
        metadata: { syncVersion: entry.sync_version },
      })
    } catch (error) {
      logError('Failed to refresh key from passkey backup', error, {
        component: 'usePasskeyBackup',
        action: 'refreshKeyFromPasskeyBackup',
      })
    }
  }, [applyRecoveredKeyBundle, doesCurrentStateMatchBundle])

  /**
   * Retry passkey authentication to recover keys from the backend.
   * Called from UI when passkeyRecoveryNeeded=true (e.g. passkey-recovery modal step).
   * Returns the recovered primary key on success, null on failure.
   */
  const recoverWithPasskey = useCallback(async (): Promise<string | null> => {
    // Each explicit user-initiated passkey action resets the session
    // "warning dismissed" flag, so a dismissal from an earlier failure
    // flow doesn't silently suppress the warning on a new attempt.
    setupWarningDismissedFlag.clear()
    if (isMountedRef.current) {
      setState((prev) => ({ ...prev, passkeyRecoveryFailure: null }))
    }
    try {
      const previousKeys = encryptionService.getAllKeys()
      const recovery = await performPasskeyRecovery()
      if (!recovery) {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            passkeyRecoveryFailure: 'auth_failed',
          }))
        }
        return null
      }

      const applied = await applyRecoveredKeyBundle(
        recovery.keyBundle,
        previousKeys,
      )
      if (!applied.mode) {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            passkeyRecoveryFailure: applied.reason,
            manualRecoveryNeeded:
              applied.reason === 'stale_backup'
                ? true
                : prev.manualRecoveryNeeded,
          }))
        }
        return null
      }

      applyRecoveredKeys(recovery)
      await maybePromoteLegacyKey(recovery)
      passkeyRecoveryDismissedFlag.clear()

      logInfo('Recovered encryption keys via passkey retry', {
        component: 'usePasskeyBackup',
        action: 'recoverWithPasskey',
        metadata: { alternativeKeys: recovery.keyBundle.alternatives.length },
      })
      return recovery.keyBundle.primary
    } catch (error) {
      if (
        error instanceof PrfNotSupportedError ||
        error instanceof PasskeyTimeoutError
      ) {
        logInfo('Passkey provider cannot complete PRF recovery', {
          component: 'usePasskeyBackup',
          action: 'recoverWithPasskey',
          metadata: { reason: error.name },
        })
        if (isMountedRef.current) {
          const alreadyDismissed = setupWarningDismissedFlag.isSet()
          setState((prev) => ({
            ...prev,
            passkeySetupFailed: alreadyDismissed
              ? prev.passkeySetupFailed
              : true,
          }))
        }
        return null
      }
      logError('Passkey recovery retry failed', error, {
        component: 'usePasskeyBackup',
        action: 'recoverWithPasskey',
      })
      return null
    }
  }, [applyRecoveredKeyBundle])

  // --- Passkey initialization (runs once after cloud sync init completes) ---
  useEffect(() => {
    if (!initialized || !isSignedIn || hasInitializedPasskeyRef.current) return
    hasInitializedPasskeyRef.current = true

    const initializePasskey = async () => {
      const prfSupported = await isPrfSupported()

      if (encryptionKey) {
        // A local key that derives a different key id than the
        // enclave's registered one can never write or migrate — this
        // device is stale and needs to converge onto the registered
        // key to enter v2. Route to passkey recovery when the
        // registered key has bundles to unlock it with, or to manual
        // key entry when it was adopted bundleless (e.g. by the
        // migration path on another device).
        const validation = await validateCurrentPrimaryKey()
        if (!validation.canWrite && validation.remoteState === 'exists') {
          let hasRemoteBundles = false
          try {
            const current = await enclaveKeyCurrent()
            hasRemoteBundles = Object.keys(current.bundles).length > 0
          } catch {
            // Transient enclave failure: fall through to the manual
            // prompt, which is dismissible and retried next visit.
          }
          if (!isMountedRef.current) return
          if (hasRemoteBundles && prfSupported) {
            if (!passkeyRecoveryDismissedFlag.isSet()) {
              setState((prev) => ({
                ...prev,
                passkeyRecoveryNeeded: true,
              }))
            }
          } else if (!manualRecoveryDismissedFlag.isSet()) {
            setState((prev) => ({
              ...prev,
              manualRecoveryNeeded: true,
              passkeySetupFailed: setupWarningDismissedFlag.isSet()
                ? prev.passkeySetupFailed
                : true,
              passkeyRetryAvailable: false,
            }))
          }
          return
        }
        if (!isMountedRef.current) return
      }

      if (!prfSupported) {
        // The device/provider can't do PRF, so passkey-backed cloud sync is
        // unavailable here. If the user has no local key and no remote data
        // we warn them that their chats will only exist on this device and
        // offer the manual-backup fallback. If remote data exists, they need
        // the manual recovery flow to decrypt it. Users who already have a
        // local key stay silent — local storage works fine even without PRF.
        if (!encryptionKey) {
          const remoteState = await inspectRemoteEncryptedState()
          if (!isMountedRef.current) return
          if (remoteState === 'empty') {
            if (!backupWarningDismissedFlag.isSet()) {
              setState((prev) => ({
                ...prev,
                passkeySetupFailed: true,
                passkeyRetryAvailable: false,
              }))
            }
          } else if (
            remoteState === 'exists' &&
            !manualRecoveryDismissedFlag.isSet()
          ) {
            // Remote data exists but PRF is unavailable on this device.
            // Surface both the recovery-needed flag (so the unlock modal
            // can open when sync is enabled) and the warning (so the user
            // knows their chats aren't being backed up right now). Hide
            // the retry button since there's nothing to retry with.
            // Skip entirely if the user previously opted out of the manual
            // recovery prompt — they can re-trigger it from Settings.
            setState((prev) => ({
              ...prev,
              manualRecoveryNeeded: true,
              passkeySetupFailed: setupWarningDismissedFlag.isSet()
                ? prev.passkeySetupFailed
                : true,
              passkeyRetryAvailable: false,
            }))
          } else if (
            remoteState === 'unknown' &&
            !backupWarningDismissedFlag.isSet()
          ) {
            setState((prev) => ({
              ...prev,
              passkeySetupFailed: true,
              passkeyRetryAvailable: false,
            }))
          }
        }
        return
      }

      if (encryptionKey) {
        // User has local keys — check for existing backup
        const localCredentialId = getLocalPasskeyCredentialId()
        const deviceState = await getPasskeyDeviceState(localCredentialId)

        if (deviceState === 'this-device') {
          // This device already has its own bundle — show green badge,
          // hide every flavour of setup button.
          localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              passkeyActive: true,
              passkeySetupAvailable: false,
              passkeyAddDeviceAvailable: false,
              manualRecoveryNeeded: false,
            }))
          }
        } else if (
          deviceState === 'other-device-only' &&
          !passkeyFlowInProgressRef.current
        ) {
          // The user's key has a bundle, but it was registered on a
          // different device. Surface a prompt so they can enroll a
          // passkey on this device too — the enclave / CP already
          // support many bundles per key.
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              passkeyAddDeviceAvailable: true,
              passkeySetupAvailable: false,
              passkeyActive: false,
            }))
          }
        } else if (
          deviceState === 'empty' &&
          !passkeyFlowInProgressRef.current
        ) {
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              passkeySetupAvailable: true,
              passkeyAddDeviceAvailable: false,
            }))
          }
        }
      } else {
        // No localStorage keys — check backend state but do not auto-prompt
        // the user with a native passkey dialog. We surface the appropriate
        // UI state flag instead and let the user trigger the WebAuthn call
        // explicitly from a confirmation or recovery modal.
        const credentialState = await getPasskeyCredentialState()

        if (credentialState === 'exists') {
          // If the user explicitly dismissed the recovery prompt on a
          // previous visit, stay silent on reload — they can re-trigger
          // recovery from Settings when they're ready.
          if (passkeyRecoveryDismissedFlag.isSet()) {
            return
          }
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              passkeyRecoveryNeeded: true,
            }))
          }
        } else if (credentialState === 'empty') {
          const remoteState = await inspectRemoteEncryptedState()

          if (remoteState === 'empty') {
            if (isMountedRef.current && !firstTimePromptDismissedFlag.isSet()) {
              setState((prev) => ({
                ...prev,
                passkeyFirstTimePromptAvailable: true,
              }))
            }
          } else if (
            remoteState === 'exists' &&
            isMountedRef.current &&
            !manualRecoveryDismissedFlag.isSet()
          ) {
            // Remote encrypted data exists but the server has no passkey
            // credential registered for this user, so we can't offer a
            // passkey-driven unlock on this device. Surface both:
            //  - manualRecoveryNeeded (existing): the recovery modal still
            //    opens when the user enables cloud sync from settings.
            //  - passkeySetupFailed (warning): tell the user their chats
            //    aren't being backed up, with manual-backup as the primary
            //    fallback. Hide the "Try Again with Passkey" button since
            //    there's no passkey to retry against.
            // Respect the session warning-dismiss flag and the persistent
            // manual-recovery dismiss flag.
            setState((prev) => ({
              ...prev,
              manualRecoveryNeeded: true,
              passkeySetupFailed: setupWarningDismissedFlag.isSet()
                ? prev.passkeySetupFailed
                : true,
              passkeyRetryAvailable: false,
            }))
          } else if (
            remoteState === 'unknown' &&
            isMountedRef.current &&
            !setupWarningDismissedFlag.isSet()
          ) {
            setState((prev) => ({
              ...prev,
              manualRecoveryNeeded: false,
              passkeyFirstTimePromptAvailable: false,
              passkeySetupFailed: true,
              passkeyRetryAvailable: true,
            }))
          }
        } else if (
          isMountedRef.current &&
          !manualRecoveryDismissedFlag.isSet()
        ) {
          setState((prev) => ({
            ...prev,
            manualRecoveryNeeded: true,
          }))
        }
      }
    }

    initializePasskey()
  }, [initialized, isSignedIn, encryptionKey])

  // Clear the persistent "recovery dismissed" flag and the session
  // first-time-prompt flag once the user has a key again (via passkey
  // recovery, successful manual-key apply, or completed first-time setup).
  // The modals will be allowed to auto-open again on a future visit if they
  // ever land back in the no-key state.
  useEffect(() => {
    if (encryptionKey) {
      passkeyRecoveryDismissedFlag.clear()
      firstTimePromptDismissedFlag.clear()
      manualRecoveryDismissedFlag.clear()
      backupWarningDismissedFlag.clear()
      if (isMountedRef.current) {
        // Once the user has a working key, the sidebar warning's
        // raison d'être disappears. Without this update the
        // "Can't access your existing backup" banner sticks around
        // until the next mount (full page reload).
        setState((prev) => {
          if (
            !prev.manualRecoveryNeeded &&
            !prev.passkeySetupFailed &&
            !prev.passkeyRecoveryNeeded &&
            prev.passkeyRecoveryFailure === null
          ) {
            return prev
          }
          return {
            ...prev,
            manualRecoveryNeeded: false,
            passkeySetupFailed: false,
            passkeyRecoveryNeeded: false,
            passkeyRecoveryFailure: null,
          }
        })
      }
    }
  }, [encryptionKey])

  // --- Periodic sync_version check ---
  useEffect(() => {
    if (!state.passkeyActive || !isSignedIn) return

    const interval = setInterval(() => {
      refreshKeyFromPasskeyBackup()
    }, SYNC_CHECK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [state.passkeyActive, isSignedIn, refreshKeyFromPasskeyBackup])

  /**
   * Create a passkey and encrypt existing localStorage keys to the backend.
   * Called from UI when passkeySetupAvailable=true (user has keys but no passkey backup).
   * Returns true on success.
   */
  const setupPasskey = useCallback(async (): Promise<boolean> => {
    const userInfo = getPasskeyUserInfo()
    if (!userInfo) return false

    setupWarningDismissedFlag.clear()
    try {
      let authorizationMode = await getCurrentCloudKeyAuthorizationMode()
      if (!authorizationMode) {
        const validation = await validateCurrentPrimaryKey()
        if (!validation.canWrite) {
          return false
        }
        await authorizeCurrentPrimaryKeyOrThrow('validated')
        authorizationMode = 'validated'
      }

      const keys = encryptionService.getAllKeys()
      if (!keys.primary) return false

      const created = await createAndStorePasskeyBackup(
        userInfo,
        {
          primary: keys.primary,
          alternatives: keys.alternatives,
          authorizationMode,
        },
        {
          knownBundleVersion: getLocalBundleVersion(),
          incrementBundleVersion: false,
          enforceRemoteBundleVersion: true,
        },
      )
      if (!created) return false

      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          passkeyActive: true,
          passkeySetupAvailable: false,
        }))
      }

      logInfo('Passkey setup completed for existing keys', {
        component: 'usePasskeyBackup',
        action: 'setupPasskey',
      })
      return true
    } catch (error) {
      if (error instanceof PrfNotSupportedError) throw error
      if (error instanceof PasskeyTimeoutError) throw error
      logError('Passkey setup failed', error, {
        component: 'usePasskeyBackup',
        action: 'setupPasskey',
      })
      return false
    }
  }, [])

  /**
   * Generate a new key + create a new passkey (explicit split).
   * Called from the recovery choice screen's "Start Fresh" button.
   * Returns the new primary key on success, null on failure/cancel.
   */
  const setupNewKeySplit = useCallback(async (): Promise<string | null> => {
    setupWarningDismissedFlag.clear()
    const previousKeys = encryptionService.getAllKeys()
    let didSetNewKey = false

    try {
      const newKey = await generateKeyWithPasskeyBackup(
        'explicit_start_fresh',
        {
          incrementBundleVersion: true,
          enforceRemoteBundleVersion: false,
        },
      )
      if (!newKey) return null
      didSetNewKey = true

      await authorizeCurrentPrimaryKeyOrThrow('explicit_start_fresh')
      applyNewPasskeyKey()

      logInfo('New key split created with passkey', {
        component: 'usePasskeyBackup',
        action: 'setupNewKeySplit',
      })
      return newKey.key
    } catch (error) {
      if (error instanceof PrfNotSupportedError) throw error
      if (error instanceof PasskeyTimeoutError) throw error
      if (didSetNewKey) {
        await rollbackToPreviousKeys(previousKeys)
      }
      logError('Failed to create new key split', error, {
        component: 'usePasskeyBackup',
        action: 'setupNewKeySplit',
      })
      return null
    }
  }, [generateKeyWithPasskeyBackup, rollbackToPreviousKeys])

  // Dismiss the sidebar "your chats aren't being backed up" warning. Persists
  // across reloads via SETTINGS_BACKUP_WARNING_DISMISSED. The persistent
  // dismiss is cleared automatically once the user regains an encryption key
  // or signs in as a different user, so legitimate future warnings can
  // resurface.
  const dismissBackupWarning = useCallback((): void => {
    setupWarningDismissedFlag.set()
    backupWarningDismissedFlag.set()
    if (isMountedRef.current) {
      setState((prev) => {
        if (prev.manualRecoveryNeeded) {
          manualRecoveryDismissedFlag.set()
        }
        return {
          ...prev,
          passkeySetupFailed: false,
          manualRecoveryNeeded: false,
        }
      })
    }
  }, [])

  /**
   * Brand-new user flow (no local key, no remote backup, PRF supported):
   * generate a key in memory, create a passkey to back it up, and persist the
   * key only after passkey creation succeeds. Invoked from the first-time
   * confirmation modal — we intentionally do not auto-trigger the native
   * passkey dialog on page load.
   */
  const setupFirstTimePasskey = useCallback(async (): Promise<boolean> => {
    setupWarningDismissedFlag.clear()
    // Single exit point for every non-success branch: close the prompt
    // modal and surface the "chats are not being backed up" warning so the
    // user always has a clear next step (manual backup or continue without).
    const markFailedAndClosePrompt = (): void => {
      if (!isMountedRef.current) return
      setState((prev) => ({
        ...prev,
        passkeyFirstTimePromptAvailable: false,
        passkeySetupFailed: true,
        passkeyRetryAvailable: true,
      }))
    }

    try {
      const remoteState = await inspectRemoteEncryptedState()
      if (remoteState === 'exists') {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            manualRecoveryNeeded: true,
            passkeyFirstTimePromptAvailable: false,
            passkeySetupFailed: true,
            passkeyRetryAvailable: false,
          }))
        }
        return false
      }
      if (remoteState === 'unknown') {
        // The probe failed (network, transient enclave error). The
        // remote may be empty or already have a key — we cannot tell
        // safely. Surface as retriable so the user can try again
        // instead of locking them out of setup.
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            passkeyFirstTimePromptAvailable: false,
            passkeySetupFailed: true,
            passkeyRetryAvailable: true,
          }))
        }
        return false
      }

      const previousKeys = encryptionService.getAllKeys()
      const generated = await generateKeyWithPasskeyBackup('validated')

      if (generated) {
        const applied = await applyRecoveredKeyBundle(
          {
            primary: generated.key,
            alternatives: [],
            authorizationMode: 'validated',
          },
          previousKeys,
        )
        if (!applied.mode) {
          await deletePasskeyCredential(generated.credentialId)
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              manualRecoveryNeeded: true,
              passkeyFirstTimePromptAvailable: false,
              passkeyRecoveryFailure: applied.reason,
            }))
          }
          return false
        }

        applyNewPasskeyKey()
        onEncryptionKeyRecoveredRef.current?.(generated.key)
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            passkeyActive: true,
            passkeyFirstTimePromptAvailable: false,
          }))
        }

        logInfo('First-time passkey setup complete', {
          component: 'usePasskeyBackup',
          action: 'setupFirstTimePasskey',
        })
        return true
      }

      markFailedAndClosePrompt()
      logInfo('Passkey creation cancelled, key discarded', {
        component: 'usePasskeyBackup',
        action: 'setupFirstTimePasskey',
      })
      return false
    } catch (error) {
      if (
        error instanceof PrfNotSupportedError ||
        error instanceof PasskeyTimeoutError
      ) {
        logInfo(
          'Passkey provider cannot support PRF backup during first-time setup',
          {
            component: 'usePasskeyBackup',
            action: 'setupFirstTimePasskey',
            metadata: { reason: error.name },
          },
        )
      } else {
        logError('First-time passkey setup failed', error, {
          component: 'usePasskeyBackup',
          action: 'setupFirstTimePasskey',
        })
      }
      markFailedAndClosePrompt()
      return false
    }
  }, [applyRecoveredKeyBundle, generateKeyWithPasskeyBackup])

  const dismissFirstTimePasskeyPrompt = useCallback((): void => {
    firstTimePromptDismissedFlag.set()
    if (!isMountedRef.current) return
    setState((prev) => ({
      ...prev,
      passkeyFirstTimePromptAvailable: false,
      // Surface the "chats are not being backed up" warning so the user has
      // a clear next step (manual backup or continue without). Respect the
      // session dismiss so we don't reopen it after they've already seen
      // and dismissed it this session.
      passkeySetupFailed: setupWarningDismissedFlag.isSet()
        ? prev.passkeySetupFailed
        : true,
    }))
  }, [])

  // Ask the hook to re-surface the passkey-recovery modal. Used when the
  // user clicks "Enable Cloud Sync" from the sidebar/settings after
  // previously dismissing the recovery prompt. Only succeeds when PRF is
  // supported, there is no local encryption key, and the backend has a
  // registered passkey credential for this user. Clears the persistent
  // dismiss flag so the recovery modal reopens, and flips
  // `passkeyRecoveryNeeded` back to true so `chat-interface` routes the
  // modal to the passkey-recovery step. Returns true if the recovery
  // prompt was made available; false if the caller should fall through to
  // another flow (first-time setup or manual key).
  const showPasskeyRecoveryPrompt = useCallback(async (): Promise<boolean> => {
    if (encryptionService.getKey()) return false
    const prfSupported = await isPrfSupported()
    if (!prfSupported) return false
    try {
      const credentialState = await getPasskeyCredentialState()
      if (credentialState !== 'exists') return false
    } catch {
      return false
    }
    passkeyRecoveryDismissedFlag.clear()
    setupWarningDismissedFlag.clear()
    if (isMountedRef.current) {
      setState((prev) => ({
        ...prev,
        passkeyRecoveryNeeded: true,
        passkeySetupFailed: false,
        passkeyRetryAvailable: true,
      }))
    }
    return true
  }, [])

  // Ask the hook to re-show the first-time setup prompt modal. Used when
  // the user clicks "Enable Cloud Sync" from the sidebar/settings after
  // previously dismissing the prompt. Only succeeds when PRF is supported
  // AND the backend has no remote passkey credential or encrypted data —
  // first-time setup would otherwise generate a new key that couldn't
  // decrypt anything already stored remotely. Returns true if the prompt
  // was made available; false if the caller should route through the
  // manual-key flow instead.
  const showFirstTimePasskeyPrompt = useCallback(async (): Promise<boolean> => {
    manualRecoveryDismissedFlag.clear()
    const prfSupported = await isPrfSupported()
    if (!prfSupported) return false
    try {
      const [credentialState, remoteState] = await Promise.all([
        getPasskeyCredentialState(),
        inspectRemoteEncryptedState(),
      ])
      if (credentialState !== 'empty') {
        return false
      }
      if (remoteState === 'exists') {
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            manualRecoveryNeeded: true,
            passkeyFirstTimePromptAvailable: false,
            passkeySetupFailed: true,
            passkeyRetryAvailable: false,
          }))
        }
        return false
      }
      if (remoteState === 'unknown') {
        setupWarningDismissedFlag.clear()
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            manualRecoveryNeeded: false,
            passkeyFirstTimePromptAvailable: false,
            passkeySetupFailed: true,
            passkeyRetryAvailable: true,
          }))
        }
        return false
      }
    } catch {
      return false
    }
    firstTimePromptDismissedFlag.clear()
    if (isMountedRef.current) {
      setState((prev) => ({
        ...prev,
        passkeyFirstTimePromptAvailable: true,
      }))
    }
    return true
  }, [])

  // User explicitly opted out of passkey recovery (e.g. "Skip for Now" on
  // the recovery modal). Persist the dismiss so we don't auto-reopen the
  // recovery modal on every reload, and clear the recovery-needed flag so
  // chat-interface closes the currently open modal. Cleared automatically
  // once the user regains an encryption key via any path.
  const skipPasskeyRecovery = useCallback((): void => {
    passkeyRecoveryDismissedFlag.set()
    if (!isMountedRef.current) return
    setState((prev) => {
      // If the user is skipping the manual-recovery flow (no passkey to
      // retry against), persist that dismissal too so the "Unlock Your
      // Chats" warning doesn't auto-open on every reload.
      if (prev.manualRecoveryNeeded) {
        manualRecoveryDismissedFlag.set()
      }
      return {
        ...prev,
        passkeyRecoveryNeeded: false,
        manualRecoveryNeeded: false,
        // Surface the "chats are not being backed up" warning so the user
        // has a clear next step (manual backup or continue without). Respect
        // the session dismiss so we don't keep reopening it.
        passkeySetupFailed: setupWarningDismissedFlag.isSet()
          ? prev.passkeySetupFailed
          : true,
        // A passkey credential is registered on the server, so retrying
        // passkey recovery is a valid next step.
        passkeyRetryAvailable: true,
      }
    })
  }, [])

  /**
   * Re-evaluate per-device bundle state. Safe to call any time the
   * server's `user_key_bundles` may have changed (e.g. another device
   * just added a bundle, the legacy-blob migration finished and
   * promoted a CEK, the user removed a credential from settings).
   * Pure read: never triggers a WebAuthn prompt.
   */
  const refreshBundleState = useCallback(async (): Promise<void> => {
    if (!encryptionKey) return
    if (passkeyFlowInProgressRef.current) return
    const localCredentialId = getLocalPasskeyCredentialId()
    const deviceState = await getPasskeyDeviceState(localCredentialId)
    if (!isMountedRef.current) return

    if (deviceState === 'this-device') {
      localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
      setState((prev) => ({
        ...prev,
        passkeyActive: true,
        passkeySetupAvailable: false,
        passkeyAddDeviceAvailable: false,
        manualRecoveryNeeded: false,
      }))
    } else if (deviceState === 'other-device-only') {
      setState((prev) => ({
        ...prev,
        passkeyAddDeviceAvailable: true,
        passkeySetupAvailable: false,
        passkeyActive: false,
      }))
    } else if (deviceState === 'empty') {
      setState((prev) => ({
        ...prev,
        passkeySetupAvailable: true,
        passkeyAddDeviceAvailable: false,
      }))
    }
  }, [encryptionKey])

  // Subscribe to bundle-state-maybe-changed events so the hook stays in
  // sync after the legacy-blob migration finishes, a different tab adds
  // a bundle via storage events, etc.
  useEffect(() => {
    const unsubscribe = passkeyEvents.on('bundle-state-maybe-changed', () => {
      void refreshBundleState()
    })
    return () => {
      unsubscribe()
    }
  }, [refreshBundleState])

  /**
   * Re-authenticate the user's legacy `/api/passkey-credentials/`
   * passkey and use the resulting PRF to write a v2 initial bundle
   * via `promoteRecoveredCekToEnclave`. Used when the user has a
   * local CEK and a legacy passkey credential, but no v2
   * `user_keys` row yet — the historical promotion only fires
   * during a recovery flow (which never happens for users whose
   * local CEK is still valid). Returns true on a successful
   * register-key.
   */
  const promoteLegacyPasskeyForCurrentDevice = useCallback(
    async (cekHex: string): Promise<boolean> => {
      const legacyEntries = (await loadRecoveryCandidates()).filter(
        (entry) => entry.source === 'legacy',
      )
      if (legacyEntries.length === 0) return false

      const credentialIds = legacyEntries.map((entry) => entry.id)
      const prf = await authenticatePrfPasskey(credentialIds)
      if (!prf) return false

      const kek = await deriveKeyEncryptionKey(prf.prfOutput)
      const result = await promoteRecoveredCekToEnclave({
        cekHex,
        credentialId: prf.credentialId,
        kek,
      })
      if (!result.ok) {
        logInfo('legacy promotion via add-device button failed', {
          component: 'usePasskeyBackup',
          action: 'promoteLegacyPasskeyForCurrentDevice',
          metadata: { reason: result.reason },
        })
        return false
      }
      return true
    },
    [],
  )

  /**
   * Add a passkey bundle for *this device* against the existing key.
   * Used when `passkeyAddDeviceAvailable === true` (another device
   * already has a bundle but this one doesn't). Wraps the local CEK
   * under a freshly-derived KEK from a new WebAuthn ceremony and
   * pushes it as an additional bundle via `add-bundle`. Returns true
   * on success.
   *
   * Also handles the legacy v1 case: if the enclave has no
   * `user_keys` row yet but the user has a credential in
   * `/api/passkey-credentials/`, this re-authenticates that
   * credential and uses the legacy promotion path so they keep
   * their original passkey on the v2 wire.
   */
  const addPasskeyToThisDevice = useCallback(async (): Promise<boolean> => {
    const userInfo = getPasskeyUserInfo()
    if (!userInfo) return false

    const keys = encryptionService.getAllKeys()
    if (!keys.primary) return false

    const cekBytes = encryptionService.getAlternativeKeyBytes(keys.primary)
    if (!cekBytes) return false
    const cekHex = cekBytesToHex(cekBytes)

    let keyIdHex: string | null
    try {
      const resp = await enclaveKeyCurrent()
      keyIdHex = resp.key_id ?? null
    } catch (error) {
      logError('Failed to read enclave key state for add-bundle', error, {
        component: 'usePasskeyBackup',
        action: 'addPasskeyToThisDevice',
      })
      return false
    }

    passkeyFlowInProgressRef.current = true
    try {
      if (keyIdHex) {
        const result = await addBundleForCurrentKey({
          cekHex,
          keyIdHex,
          user: userInfo,
        })
        if (!result.ok) {
          logInfo('add-bundle attempt failed', {
            component: 'usePasskeyBackup',
            action: 'addPasskeyToThisDevice',
            metadata: { reason: result.reason },
          })
          return false
        }
      } else {
        // Legacy v1 user: local CEK already exists, the enclave has
        // no `user_keys` row yet, but `/api/passkey-credentials/`
        // still holds the original PRF credential. Re-authenticate
        // that credential, derive the KEK, and call the legacy
        // promotion path so the user lands on the v2 wire reusing
        // their existing passkey instead of being asked to enroll
        // a brand-new one.
        const promoted = await promoteLegacyPasskeyForCurrentDevice(cekHex)
        if (!promoted) return false
      }

      localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          passkeyActive: true,
          passkeyAddDeviceAvailable: false,
          passkeySetupAvailable: false,
          passkeySetupFailed: false,
        }))
      }
      passkeyEvents.emit({ type: 'bundle-state-maybe-changed' })
      return true
    } catch (error) {
      if (error instanceof PrfNotSupportedError) throw error
      if (error instanceof PasskeyTimeoutError) throw error
      logError('Failed to add passkey for this device', error, {
        component: 'usePasskeyBackup',
        action: 'addPasskeyToThisDevice',
      })
      return false
    } finally {
      passkeyFlowInProgressRef.current = false
    }
  }, [promoteLegacyPasskeyForCurrentDevice])

  return {
    ...state,
    setupPasskey,
    setupFirstTimePasskey,
    showFirstTimePasskeyPrompt,
    showPasskeyRecoveryPrompt,
    dismissFirstTimePasskeyPrompt,
    recoverWithPasskey,
    setupNewKeySplit,
    updatePasskeyBackup,
    dismissBackupWarning,
    skipPasskeyRecovery,
    addPasskeyToThisDevice,
    refreshBundleState,
  }
}
