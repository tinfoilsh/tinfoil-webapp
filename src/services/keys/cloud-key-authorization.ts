import { encryptionService } from '../encryption/encryption-service'
import { keyCurrent, newIdempotencyKey, registerKey } from '../harness/keys'
import { harnessAPI } from '../harness/runtime'
import { requirePrimaryKeyB64 } from './cek-encoding'
import {
  CloudKeySetupError,
  validateCurrentPrimaryKey,
} from './cloud-key-preflight'
export type CloudKeyAuthorizationMode = 'validated' | 'explicit_start_fresh'
export async function getCurrentCloudKeyAuthorizationMode(): Promise<CloudKeyAuthorizationMode | null> {
  return (await validateCurrentPrimaryKey()).canWrite ? 'validated' : null
}
// A key recovered from a Start Fresh backup is authorized like any other, as
// on main: it never replaces another registered key or drops legacy data.
// Only an explicit Start Fresh calls registerStartFreshKeyIfNeeded.
export async function authorizeCurrentPrimaryKeyOrThrow(): Promise<void> {
  const validation = await validateCurrentPrimaryKey()
  if (!validation.canWrite)
    throw new CloudKeySetupError(
      validation.message ?? 'Unable to unlock your chats.',
      validation.remoteState,
    )
  const current = await keyCurrent()
  if (!current.key_id) {
    if (current.has_data) {
      // Only key candidates cross the connection. The service owns the migration job.
      const keys = [
        ...new Set([
          requirePrimaryKeyB64(),
          ...[
            encryptionService.getKey(),
            ...encryptionService.getStoredAlternatives(),
          ].flatMap((value) => {
            const bytes =
              value && encryptionService.getAlternativeKeyBytes(value)
            if (!bytes) return []
            try {
              return [btoa(String.fromCharCode(...bytes))]
            } finally {
              bytes.fill(0)
            }
          }),
        ]),
      ].map((key) => ({ key }))
      await harnessAPI().post(
        '/v1/keys/migrate-all',
        { keys, target: { key: requirePrimaryKeyB64() } },
        undefined,
        false,
      )
    } else
      await registerKey({
        keyB64: requirePrimaryKeyB64(),
        ifMatch: '*',
        createdVia: 'manual',
        idempotencyKey: newIdempotencyKey(),
      })
  }
}
export async function registerStartFreshKeyIfNeeded() {
  const current = await keyCurrent()
  const validation = await validateCurrentPrimaryKey()
  if (validation.remoteState === 'unknown')
    throw new CloudKeySetupError(
      validation.message ?? 'Unable to verify your key.',
      'unknown',
    )
  if (current.key_id && validation.canWrite) return
  await registerKey({
    keyB64: requirePrimaryKeyB64(),
    ifMatch: current.etag || '*',
    createdVia: 'start_fresh',
    idempotencyKey: newIdempotencyKey(),
  })
}
