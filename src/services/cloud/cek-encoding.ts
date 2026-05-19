/**
 * CEK encoding helpers shared by every enclave-adapter in
 * `services/cloud/`. The encryption-service stores keys as
 * `key_<base36>` strings; the enclave wire wants base64. Centralizing
 * the conversion here keeps the adapters honest and prevents the
 * `hexToB64(getKey())` bug pattern that silently produces NaN-filled
 * bytes when the input is not in fact hex.
 */

import { encryptionService } from '../encryption/encryption-service'
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
  const all = encryptionService.getAllKeys()
  const out: PullKey[] = []
  if (all.primary) {
    const bytes = encryptionService.getAlternativeKeyBytes(all.primary)
    if (bytes) out.push({ key: bytesToBase64(bytes) })
  }
  for (const alt of all.alternatives) {
    if (alt === all.primary) continue
    const bytes = encryptionService.getAlternativeKeyBytes(alt)
    if (bytes) out.push({ key: bytesToBase64(bytes) })
  }
  return out
}
