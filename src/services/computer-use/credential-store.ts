/**
 * Storage for the driver pairing **refresh credential** (architecture →
 * "Pairing & driver trust").
 *
 * The refresh credential is the long-lived, revocable root obtained once via
 * pairing; it's reused silently for new chats and only re-acquired on cleared
 * storage / new browser / revocation. It is a JS-readable bearer secret (not an
 * HttpOnly cookie — the threat model accepts this and leans on a strict CSP), so
 * keep it only here and never put it in URLs or logs.
 *
 * Per-browser, not per-chat: stored under one key in localStorage.
 */

const STORAGE_KEY = 'tinfoil-computer-use-refresh-credential'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    // Access can throw in sandboxed/Private contexts.
    return null
  }
}

/**
 * Same-tab pair-state change event. `storage` events don't fire in the tab
 * that mutated localStorage, so we dispatch this alongside set/clear to give
 * banner / toggle UX a single subscription that catches both paths
 * (pairing + 401-driven clear), cross-tab and same-tab.
 */
export const PAIR_CHANGE_EVENT = 'tinfoil-pair-change'

function emitPairChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(PAIR_CHANGE_EVENT))
}

export function getRefreshCredential(): string | null {
  return storage()?.getItem(STORAGE_KEY) ?? null
}

/**
 * Sticky flag: "user has engaged with computer-use at any point on this
 * browser." Lives next to the refresh credential because the credential
 * setter is the canonical first-engagement signal — see `use-discovered.ts`
 * for the reactive read side. Kept here to avoid a circular import.
 */
const DISCOVERED_KEY = 'tinfoil-computer-use-discovered'

export function setRefreshCredential(credential: string): void {
  storage()?.setItem(STORAGE_KEY, credential)
  // First successful pairing also flips the sticky "user has engaged with
  // computer-use" flag. Done here (not at the call site) so every path that
  // stores a credential — pairing, future re-pair flows — sets it without
  // having to remember.
  storage()?.setItem(DISCOVERED_KEY, '1')
  emitPairChange()
}

/** Forget the credential (revoked / re-pair). */
export function clearRefreshCredential(): void {
  storage()?.removeItem(STORAGE_KEY)
  emitPairChange()
}

export function isPaired(): boolean {
  return getRefreshCredential() !== null
}
