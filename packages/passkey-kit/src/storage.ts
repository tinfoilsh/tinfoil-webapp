/**
 * Pluggable local persistence for the SDK's device-side state: the cached
 * PRF output and the credential id this device owns. Adapters are
 * synchronous by design (mirroring the Web Storage API) so callers can
 * read cached state without awaiting.
 */

export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Default adapter backed by `window.localStorage`. Every operation is
 * best-effort: quota errors, privacy-mode failures, and SSR (no window)
 * all degrade to no-ops so storage problems never interrupt a passkey
 * ceremony.
 */
export const browserLocalStorageAdapter: StorageAdapter = {
  getItem(key: string): string | null {
    if (typeof localStorage === 'undefined') return null
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(key, value)
    } catch {
      // best-effort
    }
  },
  removeItem(key: string): void {
    if (typeof localStorage === 'undefined') return
    try {
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
