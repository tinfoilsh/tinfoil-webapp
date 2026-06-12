/**
 * Sync health store — the single place where sync failures become
 * user-visible state.
 *
 * The upload/download paths used to dispatch `tinfoil:sync-*`
 * CustomEvents that nothing listened to, so every terminal failure
 * was invisible. They now report into this store instead, and the
 * UI (settings Cloud Sync status row, the sidebar gear badge, the
 * per-chat "couldn't sync" icon) renders from it via
 * `useSyncHealth`.
 *
 * State model:
 *  - `gate` is the account-wide condition. `action-required` (key
 *    problems, blocked account) outranks `paused` (attestation /
 *    network trouble that retries itself); a paused report never
 *    downgrades an action-required gate.
 *  - `failedChats` tracks per-chat terminal upload failures; an
 *    entry clears when that chat finally uploads or is deleted.
 *  - `lastSyncedAt` is the wall-clock time of the last completed
 *    sync pass, shown in settings.
 *
 * Framework-free singleton with a `subscribe`/`getSnapshot` surface
 * so React consumers can use `useSyncExternalStore`.
 */

export type SyncPausedReason = 'attestation' | 'network'

export type SyncActionReason =
  | 'key-recovery'
  | 'key-mismatch'
  | 'key-conflict'
  | 'account-blocked'

export type SyncGate =
  | { kind: 'ok' }
  | { kind: 'paused'; reason: SyncPausedReason; since: number }
  | { kind: 'action-required'; reason: SyncActionReason; since: number }

export interface SyncHealthSnapshot {
  gate: SyncGate
  /** chatId -> short human-readable failure description. */
  failedChats: Readonly<Record<string, string>>
  lastSyncedAt: number | null
}

/**
 * How long sync must stay paused before the UI escalates from the
 * quiet settings status line to the attention badge. Transient
 * network blips and enclave restarts resolve well inside this
 * window; anything longer deserves the user's attention.
 */
export const SYNC_PAUSED_ATTENTION_AFTER_MS = 5 * 60 * 1000

const OK_GATE: SyncGate = { kind: 'ok' }

const EMPTY_SNAPSHOT: SyncHealthSnapshot = {
  gate: OK_GATE,
  failedChats: {},
  lastSyncedAt: null,
}

type Listener = () => void

let snapshot: SyncHealthSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<Listener>()

function publish(next: SyncHealthSnapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeSyncHealth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSyncHealthSnapshot(): SyncHealthSnapshot {
  return snapshot
}

/**
 * Stable reference for SSR / first client render, before any sync
 * activity has been reported.
 */
export function getSyncHealthServerSnapshot(): SyncHealthSnapshot {
  return EMPTY_SNAPSHOT
}

/**
 * The local key cannot write (stale after a rotation, unknown to the
 * enclave, or colliding with data under another key) or the account
 * is blocked. Requires a user-driven fix, so it sticks until
 * `reportKeyHealthy` confirms the key validates again.
 */
export function reportKeyActionRequired(reason: SyncActionReason): void {
  if (
    snapshot.gate.kind === 'action-required' &&
    snapshot.gate.reason === reason
  ) {
    return
  }
  publish({
    ...snapshot,
    gate: { kind: 'action-required', reason, since: Date.now() },
  })
}

/**
 * Sync is blocked by something that retries itself (attestation
 * failure, network trouble). Never downgrades an action-required
 * gate: a key problem stays the headline until it is fixed.
 */
export function reportSyncPaused(reason: SyncPausedReason): void {
  if (snapshot.gate.kind === 'action-required') return
  if (snapshot.gate.kind === 'paused' && snapshot.gate.reason === reason) {
    return
  }
  publish({
    ...snapshot,
    gate: { kind: 'paused', reason, since: Date.now() },
  })
}

/**
 * The enclave confirmed the local key is the registered current key.
 * Clears any gate — reaching that verdict required a healthy enclave
 * round trip, so a paused gate is stale too.
 */
export function reportKeyHealthy(): void {
  if (snapshot.gate.kind === 'ok') return
  publish({ ...snapshot, gate: OK_GATE })
}

/**
 * A sync pass completed against the enclave. Stamps `lastSyncedAt`
 * and clears a paused gate. Deliberately does NOT clear
 * action-required: sync passes can "complete" while every write is
 * still being gated by a key problem.
 */
export function reportSyncSuccess(): void {
  publish({
    ...snapshot,
    gate: snapshot.gate.kind === 'paused' ? OK_GATE : snapshot.gate,
    lastSyncedAt: Date.now(),
  })
}

export function reportChatSyncFailed(chatId: string, message: string): void {
  if (snapshot.failedChats[chatId] === message) return
  publish({
    ...snapshot,
    failedChats: { ...snapshot.failedChats, [chatId]: message },
  })
}

/** Clears a chat's failure entry (successful upload or deletion). */
export function reportChatSynced(chatId: string): void {
  if (!(chatId in snapshot.failedChats)) return
  const failedChats = { ...snapshot.failedChats }
  delete failedChats[chatId]
  publish({ ...snapshot, failedChats })
}

/** Full reset (sign-out, tests). */
export function resetSyncHealth(): void {
  if (snapshot === EMPTY_SNAPSHOT) return
  publish(EMPTY_SNAPSHOT)
}

/**
 * Whether the current state deserves the attention badge on the
 * settings entry point: a key problem, a chat that cannot sync, or
 * a pause that has outlived the self-healing window.
 */
export function syncHealthNeedsAttention(
  state: SyncHealthSnapshot,
  now: number = Date.now(),
): boolean {
  if (state.gate.kind === 'action-required') return true
  if (Object.keys(state.failedChats).length > 0) return true
  return (
    state.gate.kind === 'paused' &&
    now - state.gate.since >= SYNC_PAUSED_ATTENTION_AFTER_MS
  )
}
