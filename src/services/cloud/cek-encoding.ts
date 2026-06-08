/**
 * CEK encoding helpers shared by every enclave-adapter in
 * `services/cloud/`. The encryption-service stores keys as
 * `key_<base36>` strings; the enclave wire wants base64. Centralizing
 * the conversion here keeps the adapters honest and prevents the
 * `hexToB64(getKey())` bug pattern that silently produces NaN-filled
 * bytes when the input is not in fact hex.
 */

import { encryptionService } from '../encryption/encryption-service'
import { deriveKeyIdHex } from '../sync-enclave/key-bundle'
import { bytesToBase64, type PullKey } from '../sync-enclave/sync-api'

/**
 * Encode the current primary CEK as base64. Throws when no key is
 * loaded.
 */
export function requirePrimaryKeyB64(): string {
  const bytes = encryptionService.getKeyBytesOrThrow()
  return bytesToBase64(bytes)
}

/**
 * Whether a primary CEK is currently loaded. The legacy-blob
 * migration derives both its target and candidate-key set from the
 * primary key, so it cannot run without one. Callers gate the
 * once-per-session migration kick on this: a keyless device (e.g. a
 * v1→v2 user still waiting on passkey recovery) must not consume the
 * one-shot before the key arrives, or the real migration that should
 * run once the key is recovered would be skipped for the whole
 * session.
 */
export function hasPrimaryKey(): boolean {
  return encryptionService.getKey() != null
}

/**
 * Derive the controlplane key_id (hex) of the loaded primary CEK, or
 * null when no key is loaded. Callers use this to confirm the local
 * key is the controlplane's registered current key before running the
 * legacy-blob migration: migrate-all re-seals rows via Rewrap, which
 * the controlplane rejects with 409 stale key unless the target key is
 * already the current key.
 */
export async function primaryKeyIdHexOrNull(): Promise<string | null> {
  if (encryptionService.getKey() == null) return null
  return deriveKeyIdHex(encryptionService.getKeyBytesOrThrow())
}

/**
 * Build the `keys` array for the steady-state read path: only the
 * caller's current primary CEK. v2 rows are sealed under the primary
 * and decrypt cleanly here; anything that doesn't decrypt is treated
 * as UNKNOWN_KEY by the enclave instead of silently trying historical
 * keys. The migration sweep is the only path that needs alternatives.
 */
export function pullKey(): PullKey[] {
  return [{ key: requirePrimaryKeyB64() }]
}

/**
 * Build the `keys` array for the migration path: primary first, then
 * every alternative (history) key the local service still has on
 * file, base64-encoded. The enclave tries each in turn when
 * unsealing legacy v0/v1 blobs and uses `keys[0]` as the rewrap
 * target. Once the one-shot sweep reports `fullyMigrated`, the
 * alternatives are cleared from local state and this helper
 * collapses to the same shape as `pullKey()`.
 */
export function migrationKeys(): PullKey[] {
  const out: PullKey[] = []
  // Source both primary and alternatives from localStorage so a
  // freshly-loaded service (page refresh before `initialize()` runs)
  // still surfaces every historical key on the migration sweep. The
  // in-memory `getAllKeys()` cache lags `setKey()` and would drop
  // alternatives that the persisted history has on file.
  const primary = encryptionService.getKey()
  if (primary) {
    const bytes = encryptionService.getAlternativeKeyBytes(primary)
    if (bytes) out.push({ key: bytesToBase64(bytes) })
  }
  const alternatives = encryptionService.getStoredAlternatives()
  for (const alt of alternatives) {
    if (alt === primary) continue
    const bytes = encryptionService.getAlternativeKeyBytes(alt)
    if (bytes) out.push({ key: bytesToBase64(bytes) })
  }
  return out
}
