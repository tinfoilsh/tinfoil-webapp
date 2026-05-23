/**
 * §9.6 R5 — Three terminal chat health states the UI selects against.
 *
 * Every chat is in exactly one of the three states below at any
 * moment, and the UI renders each in a dedicated surface.
 *
 *   HEALTHY     — plaintext available; renders in the main list.
 *   UNREACHABLE — the row exists on the server but cannot be read
 *                 right now (network offline, attestation pending,
 *                 key not yet recovered). Hidden from the main list,
 *                 surfaced in a dedicated "Unavailable" drawer with a
 *                 one-click retry. No placeholder body.
 *   LOST        — the row exists on the server but is provably
 *                 undecryptable (UNKNOWN_KEY after recovery completed,
 *                 SYNC_CONFLICT marked unresolvable). Surfaced in a
 *                 dedicated "Recover" UI with explicit user actions.
 *
 * The v2 enclave path NEVER produces UNREACHABLE / LOST states from
 * a "decryption failed" condition — it returns plaintext or a typed
 * error, and the caller maps the error via §9.6 R4 to the appropriate
 * surface.
 */

import type { StoredChat } from '../storage/indexed-db'

export type ChatHealth = 'HEALTHY' | 'UNREACHABLE' | 'LOST'

/**
 * Derive a chat's health bucket from its stored state.
 *
 * - `dataCorrupted: true` is permanently LOST: the server bytes do not
 *   decrypt under any known key.
 * - `decryptionFailed: true` is UNREACHABLE: the user may yet recover
 *   the key (passkey unlock, manual key entry), so retry, don't terminate.
 * - Everything else (decoded title, decoded messages) is HEALTHY.
 */
export function chatHealth(chat: StoredChat): ChatHealth {
  if (chat.dataCorrupted) return 'LOST'
  if (chat.decryptionFailed) return 'UNREACHABLE'
  return 'HEALTHY'
}

export function isHealthy(chat: StoredChat): boolean {
  return chatHealth(chat) === 'HEALTHY'
}

export function isUnreachable(chat: StoredChat): boolean {
  return chatHealth(chat) === 'UNREACHABLE'
}

export function isLost(chat: StoredChat): boolean {
  return chatHealth(chat) === 'LOST'
}
