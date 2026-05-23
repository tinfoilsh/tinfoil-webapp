import { getSyncEnclaveClient, SyncEnclaveError } from '@/services/sync-enclave'
import { logError, logInfo } from '@/utils/error-handling'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Holds the per-session sync enclave state shared between
 * use-passkey-backup (which publishes bundles) and use-cloud-sync
 * (which reads/writes blobs):
 *
 *   - `cek`        — the raw 32-byte content encryption key.
 *   - `keyIdHex`   — the user's current key_id as confirmed by the
 *                    enclave (or `null` until first register).
 *   - `status`     — "idle" | "attesting" | "ready" | "paused".
 *                    "paused" means attestation or the enclave is
 *                    failing; UI surfaces this as a quiet "Cloud sync
 *                    paused — retrying" line in the sidebar.
 *
 * The CEK is held in memory after passkey unlock so the enclave can
 * receive it on push/pull calls. Attestation errors surface up front
 * rather than at first write. The hook never deletes localStorage CEK
 * material; only bookkeeping is touched elsewhere, and only after a
 * successful register call.
 */

export type SyncEnclaveSessionStatus =
  | 'idle' /* not signed in / no CEK yet */
  | 'attesting' /* verifying enclave, deriving subkey */
  | 'ready' /* fully usable */
  | 'paused' /* attestation/network failing; retrying quietly */

export interface SyncEnclaveSession {
  status: SyncEnclaveSessionStatus
  /** Hex-encoded CEK, or null when not unlocked. */
  cekHex: string | null
  /** Current key_id as confirmed by the enclave, or null. */
  keyIdHex: string | null
  /** Last error surfaced (used for diagnostics, not user copy). */
  lastError: Error | null
  /**
   * Force a re-attestation. Useful after sign-in, after passkey
   * recovery, and from the quiet retry loop.
   */
  retry: () => void
  /**
   * Drop in-memory key material. Called from sign-out cleanup; does
   * NOT touch localStorage (Phase 2 contract).
   */
  clear: () => void
  /**
   * Publish a freshly-confirmed key_id without forcing a full
   * re-derive. Called by use-passkey-backup after registerKey
   * returns 200, and by cross-device adoption / rotation paths so
   * the enclave's view stays in sync with the hook state.
   */
  setKeyIdHex: (kid: string | null) => void
}

const RETRY_INTERVAL_MS = 60_000

export function useSyncEnclaveSession(
  unlockedCekHex: string | null,
  options?: { onReady?: (keyIdHex: string | null) => void },
): SyncEnclaveSession {
  const [status, setStatus] = useState<SyncEnclaveSessionStatus>('idle')
  const [cekHex, setCekHex] = useState<string | null>(null)
  const [keyIdHex, setKeyIdHex] = useState<string | null>(null)
  const [lastError, setLastError] = useState<Error | null>(null)

  const generationRef = useRef(0)
  const isMountedRef = useRef(true)
  const onReadyRef = useRef(options?.onReady)
  onReadyRef.current = options?.onReady
  // Mirror keyIdHex into a ref so attestAndDerive can read the
  // current value without depending on it. Including keyIdHex in the
  // useCallback deps would change the callback's identity whenever
  // setKeyIdHex is called externally (use-passkey-backup, rotation
  // paths) and the eager-re-attest useEffect below would then fire a
  // full re-attestation on every kid publish — contradicting the
  // documented "without forcing a full re-derive" contract.
  const keyIdHexRef = useRef(keyIdHex)
  keyIdHexRef.current = keyIdHex

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const attestAndDerive = useCallback(async (cekHexValue: string) => {
    const gen = ++generationRef.current
    setStatus('attesting')
    setLastError(null)
    try {
      await getSyncEnclaveClient()
      if (!isMountedRef.current || gen !== generationRef.current) return
      setCekHex(cekHexValue)
      setStatus('ready')
      logInfo('sync enclave session ready', {
        component: 'useSyncEnclaveSession',
        action: 'attestAndDerive',
      })
      try {
        onReadyRef.current?.(keyIdHexRef.current)
      } catch (err) {
        logError(
          'onReady callback threw',
          err instanceof Error ? err : new Error(String(err)),
          { component: 'useSyncEnclaveSession', action: 'onReady' },
        )
      }
    } catch (err) {
      if (!isMountedRef.current || gen !== generationRef.current) return
      const e = err instanceof Error ? err : new Error(String(err))
      setLastError(e)
      setStatus('paused')
      const code = err instanceof SyncEnclaveError ? err.code : undefined
      logError('sync enclave session paused', e, {
        component: 'useSyncEnclaveSession',
        action: 'attestAndDerive',
        metadata: { code },
      })
    }
  }, [])

  // Eager (re)-attest when the unlocked CEK changes.
  useEffect(() => {
    if (!unlockedCekHex) {
      generationRef.current++
      setStatus('idle')
      setCekHex(null)
      setKeyIdHex(null)
      setLastError(null)
      return
    }
    void attestAndDerive(unlockedCekHex)
  }, [unlockedCekHex, attestAndDerive])

  // Quiet 60s retry while paused. No banners, no toasts, no logs the
  // user can see — only the sidebar status line driven by `status`.
  useEffect(() => {
    if (status !== 'paused' || !unlockedCekHex) return
    const t = setInterval(() => {
      void attestAndDerive(unlockedCekHex)
    }, RETRY_INTERVAL_MS)
    return () => clearInterval(t)
  }, [status, unlockedCekHex, attestAndDerive])

  const retry = useCallback(() => {
    if (unlockedCekHex) void attestAndDerive(unlockedCekHex)
  }, [unlockedCekHex, attestAndDerive])

  const clear = useCallback(() => {
    generationRef.current++
    setStatus('idle')
    setCekHex(null)
    setKeyIdHex(null)
    setLastError(null)
  }, [])

  // Allow external paths (use-passkey-backup) to publish a freshly
  // confirmed keyIdHex without forcing a full re-derive. Used after
  // registerKey returns 200.
  const setKeyId = useCallback((kid: string | null) => {
    setKeyIdHex(kid)
  }, [])

  const session: SyncEnclaveSession = {
    status,
    cekHex,
    keyIdHex,
    lastError,
    retry,
    clear,
    setKeyIdHex: setKeyId,
  }
  return session
}
