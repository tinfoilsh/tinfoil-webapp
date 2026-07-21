/**
 * Pluggable local persistence for the SDK's device-side state: the cached
 * PRF output and the credential id this device owns. Adapters are
 * synchronous by design (mirroring the Web Storage API) so callers can
 * read cached state without awaiting.
 *
 * SECURITY: the PRF output cached through an adapter is raw key material —
 * anyone who can read it can re-derive the KEK and unwrap the CEK. The
 * default `localStorage` adapter stores it in plaintext, which is only as
 * strong as the origin's script-injection defenses (an XSS attacker could
 * equally just run the ceremony or exfiltrate decrypted data). Hosts with
 * stricter requirements should supply their own adapter with at-rest
 * protection, or pass `storage: null` to disable caching and re-prompt
 * biometrics instead.
 */

export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Default adapter backed by `window.localStorage`. Every operation is
 * best-effort: quota errors, privacy-mode failures, blocked-storage
 * contexts (e.g. sandboxed frames, where even touching `localStorage`
 * throws), and SSR (no window) all degrade to no-ops so storage problems
 * never interrupt a passkey ceremony.
 */
export const browserLocalStorageAdapter: StorageAdapter = {
  getItem(key: string): string | null {
    try {
      if (typeof localStorage === 'undefined') return null
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(key, value)
    } catch {
      // best-effort
    }
  },
  removeItem(key: string): void {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.removeItem(key)
    } catch {
      // best-effort
    }
  },
}

/** In-memory adapter for tests and non-browser environments. */
export function createMemoryStorageAdapter(): StorageAdapter {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value)
    },
    removeItem: (key) => {
      store.delete(key)
    },
  }
}
