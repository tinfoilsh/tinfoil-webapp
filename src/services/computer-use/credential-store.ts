/**
 * Storage for the broker pairing **refresh credential** (architecture →
 * "Pairing & broker trust").
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

export function getRefreshCredential(): string | null {
  return storage()?.getItem(STORAGE_KEY) ?? null
}

export function setRefreshCredential(credential: string): void {
  storage()?.setItem(STORAGE_KEY, credential)
}

/** Forget the credential (revoked / re-pair). */
export function clearRefreshCredential(): void {
  storage()?.removeItem(STORAGE_KEY)
}

export function isPaired(): boolean {
  return getRefreshCredential() !== null
}
