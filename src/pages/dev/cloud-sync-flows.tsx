'use client'

import { CloudSyncSetupModal } from '@/components/modals/cloud-sync-setup-modal'
import type {
  CloudKeySetupFailureReason,
  CloudKeySetupMode,
  CloudKeySetupResult,
} from '@/components/modals/cloud-sync-setup-mode'
import { IS_DEV } from '@/config'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL,
} from '@/constants/storage-keys'
import type { PasskeyRecoveryFailure } from '@/hooks/use-passkey-backup'
import Head from 'next/head'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Dev-only harness for exercising every cloud-sync popup start state
 * without touching the signed-in account. All modal callbacks are
 * stubbed: nothing is written to the enclave or backend, and the few
 * localStorage flags the modal itself persists are snapshotted before a
 * scenario opens and restored when it closes.
 *
 * Available at /dev/cloud-sync-flows when running `next dev` (or a
 * NEXT_PUBLIC_DEV=true build served from localhost).
 */

const SIMULATED_CALLBACK_LATENCY_MS = 700
const DEFERRED_PROBE_DELAY_MS = 2500

// localStorage keys the modal writes on its own; snapshotted/restored
// around each scenario so simulations never leak into real app state.
const PROTECTED_STORAGE_KEYS = [
  SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL,
  SETTINGS_CLOUD_SYNC_ENABLED,
  'cloudSyncEnabled',
] as const

type RecoveryOutcome = 'success' | 'auth_failed' | 'stale_backup'
type StartFreshOutcome = 'success' | 'failure'
type FirstTimeOutcome = 'success' | 'cancelled'

interface Scenario {
  id: string
  title: string
  description: string
  kind: 'setup-modal' | 'first-time-prompt'
  prfSupported?: boolean
  passkeyRecoveryNeeded?: boolean
  manualRecoveryNeeded?: boolean
  /** Simulate the slow background enclave probe upgrading the flow. */
  deferredRecoveryProbe?: boolean
  recoveryOutcome?: RecoveryOutcome
}

const SCENARIOS: Scenario[] = [
  {
    id: 'first-time-prompt',
    title: 'First-time user (passkey setup)',
    description:
      'Brand-new signed-in user: no local key, no remote passkey, no remote data, PRF supported. Shows the cloud sync intro first, then "Continue" opens the passkey setup prompt.',
    kind: 'first-time-prompt',
    prfSupported: true,
  },
  {
    id: 'prf-generate-or-restore',
    title: 'PRF supported, fresh setup',
    description:
      'PRF-capable device, no recovery needed. Modal opens on the intro and continues to generate-or-restore. Generating a key auto-completes without the manual "save this key" step.',
    kind: 'setup-modal',
    prfSupported: true,
  },
  {
    id: 'no-prf-intro',
    title: 'No PRF support (intro step)',
    description:
      'Passkey provider without PRF, no remote data. Modal opens on the classic intro step with the enable toggle, then routes through the manual key flow.',
    kind: 'setup-modal',
    prfSupported: false,
  },
  {
    id: 'passkey-recovery',
    title: 'Remote passkey, no local key (recovery succeeds)',
    description:
      'Backend has a passkey credential but this device has no key (passkeyRecoveryNeeded=true). Modal auto-opens on "Unlock Your Chats". Simulated passkey auth succeeds.',
    kind: 'setup-modal',
    prfSupported: true,
    passkeyRecoveryNeeded: true,
    recoveryOutcome: 'success',
  },
  {
    id: 'passkey-recovery-auth-failed',
    title: 'Passkey recovery: auth fails',
    description:
      'Same start state, but the simulated passkey authentication fails (user cancels / wrong passkey). Shows the amber auth_failed warning with retry, manual key, and start-fresh escape hatches.',
    kind: 'setup-modal',
    prfSupported: true,
    passkeyRecoveryNeeded: true,
    recoveryOutcome: 'auth_failed',
  },
  {
    id: 'passkey-recovery-stale',
    title: 'Passkey recovery: stale backup',
    description:
      'Passkey authenticates, but its wrapped key does not match the existing cloud data (stale_backup). Also flips manualRecoveryNeeded, matching the real hook behaviour.',
    kind: 'setup-modal',
    prfSupported: true,
    passkeyRecoveryNeeded: true,
    recoveryOutcome: 'stale_backup',
  },
  {
    id: 'manual-recovery',
    title: 'Remote data, no usable passkey (manual recovery)',
    description:
      'Remote encrypted data exists but there is no passkey to unlock it with (manualRecoveryNeeded=true). Opens on generate-or-restore with restore-focused copy; "Start Fresh" routes through the destructive confirmation step.',
    kind: 'setup-modal',
    prfSupported: false,
    manualRecoveryNeeded: true,
  },
  {
    id: 'manual',
    title: 'Manual flow (PRF-less provider)',
    description:
      'User sees the cloud sync intro before continuing to manual key setup.',
    kind: 'setup-modal',
    prfSupported: false,
  },
  {
    id: 'deferred-probe',
    title: 'Deferred probe upgrade',
    description:
      'Modal opens instantly on the intro while the background enclave probe is still running; after a simulated delay the probe reports a remote passkey and the modal advances to the recovery step.',
    kind: 'setup-modal',
    prfSupported: true,
    deferredRecoveryProbe: true,
    recoveryOutcome: 'success',
  },
]

interface LogEntry {
  time: string
  message: string
}

function snapshotProtectedStorage(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {}
  for (const key of PROTECTED_STORAGE_KEYS) {
    try {
      snapshot[key] = localStorage.getItem(key)
    } catch {
      snapshot[key] = null
    }
  }
  return snapshot
}

function restoreProtectedStorage(
  snapshot: Record<string, string | null>,
): void {
  for (const key of PROTECTED_STORAGE_KEYS) {
    try {
      const value = snapshot[key]
      if (value === null) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, value)
      }
    } catch {
      // best-effort
    }
  }
}

function simulateLatency(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, SIMULATED_CALLBACK_LATENCY_MS),
  )
}

export default function CloudSyncFlowsDevPage() {
  const [harnessEnabled, setHarnessEnabled] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [scenarioRunId, setScenarioRunId] = useState(0)
  const [log, setLog] = useState<LogEntry[]>([])

  // Live flags mirrored from what usePasskeyBackup would expose; the
  // simulated callbacks mutate these the same way the real hook does.
  const [passkeyRecoveryNeeded, setPasskeyRecoveryNeeded] = useState(false)
  const [manualRecoveryNeeded, setManualRecoveryNeeded] = useState(false)
  const [recoveryFailure, setRecoveryFailure] =
    useState<PasskeyRecoveryFailure | null>(null)
  const [isFirstTimeBusy, setIsFirstTimeBusy] = useState(false)

  // Configurable simulated outcomes
  const [setupResult, setSetupResult] = useState<
    'ok' | CloudKeySetupFailureReason
  >('ok')
  const [startFreshOutcome, setStartFreshOutcome] =
    useState<StartFreshOutcome>('success')
  const [firstTimeOutcome, setFirstTimeOutcome] =
    useState<FirstTimeOutcome>('success')

  const storageSnapshotRef = useRef<Record<string, string | null> | null>(null)
  const deferredProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  useEffect(() => {
    // Runtime gate is evaluated on the client so static-export builds
    // and dev servers behave identically (and to avoid SSR hydration
    // mismatches).
    setHarnessEnabled(process.env.NODE_ENV === 'development' || IS_DEV)
  }, [])

  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(
        document.documentElement.getAttribute('data-theme') === 'dark',
      )
    }
    checkDarkMode()
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, { attributes: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      if (deferredProbeTimerRef.current) {
        clearTimeout(deferredProbeTimerRef.current)
      }
      if (storageSnapshotRef.current) {
        restoreProtectedStorage(storageSnapshotRef.current)
        storageSnapshotRef.current = null
      }
    }
  }, [])

  const appendLog = useCallback((message: string) => {
    setLog((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), message },
    ])
  }, [])

  const openScenario = useCallback(
    (next: Scenario) => {
      // A pending probe timer from a previous run would otherwise fire
      // mid-scenario and yank the new run into the recovery step.
      if (deferredProbeTimerRef.current) {
        clearTimeout(deferredProbeTimerRef.current)
        deferredProbeTimerRef.current = null
      }
      storageSnapshotRef.current ??= snapshotProtectedStorage()
      setPasskeyRecoveryNeeded(
        Boolean(next.passkeyRecoveryNeeded) && !next.deferredRecoveryProbe,
      )
      setManualRecoveryNeeded(Boolean(next.manualRecoveryNeeded))
      setRecoveryFailure(null)
      setScenarioRunId((id) => id + 1)
      setScenario(next)
      appendLog(`--- opened scenario: ${next.title} ---`)

      if (next.deferredRecoveryProbe) {
        deferredProbeTimerRef.current = setTimeout(() => {
          appendLog(
            'background probe resolved: remote passkey found, upgrading to recovery step',
          )
          setPasskeyRecoveryNeeded(true)
        }, DEFERRED_PROBE_DELAY_MS)
      }
    },
    [appendLog],
  )

  const closeScenario = useCallback(() => {
    if (deferredProbeTimerRef.current) {
      clearTimeout(deferredProbeTimerRef.current)
      deferredProbeTimerRef.current = null
    }
    if (storageSnapshotRef.current) {
      restoreProtectedStorage(storageSnapshotRef.current)
      storageSnapshotRef.current = null
    }
    setScenario(null)
    appendLog('--- scenario closed (localStorage restored) ---')
  }, [appendLog])

  const handleSetupComplete = useCallback(
    async (
      key: string,
      mode: CloudKeySetupMode,
    ): Promise<CloudKeySetupResult> => {
      appendLog(
        `onSetupComplete(mode=${mode}, key=${key.slice(0, 12)}…) → simulating "${setupResult}"`,
      )
      await simulateLatency()
      if (setupResult === 'ok') {
        appendLog('key activation simulated OK (nothing persisted remotely)')
        return { ok: true }
      }
      return { ok: false, reason: setupResult }
    },
    [appendLog, setupResult],
  )

  const handleRecoverWithPasskey = useCallback(async (): Promise<boolean> => {
    const outcome = scenario?.recoveryOutcome ?? 'success'
    appendLog(`onRecoverWithPasskey() → simulating "${outcome}"`)
    setRecoveryFailure(null)
    await simulateLatency()
    if (outcome === 'success') {
      appendLog('passkey recovery simulated OK')
      return true
    }
    setRecoveryFailure(outcome)
    if (outcome === 'stale_backup') {
      setManualRecoveryNeeded(true)
    }
    return false
  }, [appendLog, scenario])

  const handleSetupNewKey = useCallback(async (): Promise<string | null> => {
    appendLog(`onSetupNewKey() → simulating "${startFreshOutcome}"`)
    await simulateLatency()
    if (startFreshOutcome !== 'success') return null
    return 'simulated-new-encryption-key-for-display'
  }, [appendLog, startFreshOutcome])

  const handleFirstTimeEnable = useCallback(async () => {
    appendLog(
      `first-time onEnable() → simulating passkey creation "${firstTimeOutcome}"`,
    )
    setIsFirstTimeBusy(true)
    try {
      await simulateLatency()
      if (firstTimeOutcome === 'success') {
        appendLog('first-time passkey setup simulated OK')
        return true
      } else {
        appendLog(
          'passkey creation simulated as cancelled (real flow would surface the backup warning)',
        )
        return false
      }
    } finally {
      setIsFirstTimeBusy(false)
    }
  }, [appendLog, firstTimeOutcome])

  if (!harnessEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-chat-background font-aeonik text-content-primary">
        <p className="text-sm text-content-secondary">
          This page is only available in local dev mode.
        </p>
      </div>
    )
  }

  const prfSupported = scenario?.prfSupported ?? false

  return (
    <>
      <Head>
        <title>Cloud Sync Flow Simulator</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="min-h-screen bg-surface-chat-background p-6 font-aeonik text-content-primary">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Cloud Sync Flow Simulator</h1>
            <p className="mt-1 text-sm text-content-secondary">
              Trigger every cloud-sync popup start state with stubbed callbacks.
              Nothing here talks to the enclave or your account; localStorage
              flags touched by the modal are restored when a scenario closes.
            </p>
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
            <h2 className="text-sm font-semibold">Simulated outcomes</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-content-secondary">
                Key activation (onSetupComplete)
                <select
                  value={setupResult}
                  onChange={(e) =>
                    setSetupResult(
                      e.target.value as 'ok' | CloudKeySetupFailureReason,
                    )
                  }
                  className="rounded-md border border-border-subtle bg-surface-input px-2 py-1.5 text-sm text-content-primary"
                >
                  <option value="ok">ok</option>
                  <option value="key_mismatch">key_mismatch</option>
                  <option value="verification_unavailable">
                    verification_unavailable
                  </option>
                  <option value="invalid_key">invalid_key</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-content-secondary">
                Start Fresh (onSetupNewKey)
                <select
                  value={startFreshOutcome}
                  onChange={(e) =>
                    setStartFreshOutcome(e.target.value as StartFreshOutcome)
                  }
                  className="rounded-md border border-border-subtle bg-surface-input px-2 py-1.5 text-sm text-content-primary"
                >
                  <option value="success">success</option>
                  <option value="failure">failure</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-content-secondary">
                First-time passkey creation
                <select
                  value={firstTimeOutcome}
                  onChange={(e) =>
                    setFirstTimeOutcome(e.target.value as FirstTimeOutcome)
                  }
                  className="rounded-md border border-border-subtle bg-surface-input px-2 py-1.5 text-sm text-content-primary"
                >
                  <option value="success">success</option>
                  <option value="cancelled">cancelled</option>
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-content-muted">
              Note: generating a key in a non-manual scenario still runs the
              read-only remote-state probe, which may fail silently on localhost
              and default to the &quot;recoverExisting&quot; path.
            </p>
          </div>

          <div className="space-y-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => openScenario(s)}
                className="w-full rounded-lg border border-border-subtle bg-surface-card p-4 text-left transition-colors hover:bg-surface-chat"
              >
                <div className="text-sm font-semibold">{s.title}</div>
                <div className="mt-1 text-xs text-content-secondary">
                  {s.description}
                </div>
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Event log</h2>
              <button
                onClick={() => setLog([])}
                className="text-xs text-content-muted hover:text-content-secondary"
              >
                Clear
              </button>
            </div>
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs text-content-secondary">
              {log.length === 0 && (
                <p className="text-content-muted">No events yet.</p>
              )}
              {log.map((entry, i) => (
                <div key={i}>
                  <span className="text-content-muted">{entry.time}</span>{' '}
                  {entry.message}
                </div>
              ))}
            </div>
          </div>
        </div>

        {(scenario?.kind === 'setup-modal' ||
          scenario?.kind === 'first-time-prompt') && (
          <CloudSyncSetupModal
            key={scenarioRunId}
            isOpen
            onClose={closeScenario}
            onSetupComplete={handleSetupComplete}
            isDarkMode={isDarkMode}
            prfSupported={prfSupported}
            passkeyRecoveryNeeded={passkeyRecoveryNeeded}
            manualRecoveryNeeded={manualRecoveryNeeded}
            passkeyRecoveryFailure={recoveryFailure}
            onSetupWithPasskey={
              scenario.kind === 'first-time-prompt'
                ? handleFirstTimeEnable
                : undefined
            }
            isPasskeySetupBusy={isFirstTimeBusy}
            onSkipRecovery={() => {
              appendLog('onSkipRecovery() (real flow persists a dismiss flag)')
              closeScenario()
            }}
            onRecoverWithPasskey={handleRecoverWithPasskey}
            onSetupNewKey={handleSetupNewKey}
          />
        )}
      </div>
    </>
  )
}
