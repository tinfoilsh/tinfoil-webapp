import { PROMPT_CACHE_SECRET_PREFIX } from '@/constants/storage-keys'
import type { Turn } from './types'

// The secret that scopes this browser's prompt cache at the model enclaves.
// The harness hashes it into the scope the gateway routes model requests by,
// so nothing the gateway can derive from the caller's credential tells which
// prompts share a cache. An account keeps its own for as long as it is
// signed in here; a visitor's lasts the tab, as the visitor's chats do.
const SECRET_BYTES = 32
const secretPattern = /^[0-9a-f]{64}$/

function storageKey(userId: string | null) {
  return `${PROMPT_CACHE_SECRET_PREFIX}:${encodeURIComponent(userId ?? 'anonymous')}`
}

export function promptCacheSecret(userId: string | null): string | undefined {
  try {
    const storage = userId ? localStorage : sessionStorage
    const key = storageKey(userId)
    const stored = storage.getItem(key)
    if (stored && secretPattern.test(stored)) return stored
    const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
    const secret = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    storage.setItem(key, secret)
    return secret
  } catch {
    // Without storage, the harness gives each chat a cache of its own.
    return undefined
  }
}

// A turn as it is sent, scoped to this browser's prompt cache.
export function scopedTurn(turn: Turn, userId: string | null): Turn {
  const cacheSecret = promptCacheSecret(userId)
  if (!cacheSecret) return turn
  return { ...turn, options: { ...turn.options, cacheSecret } }
}
