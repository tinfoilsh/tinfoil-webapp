import { encryptionService } from '../encryption/encryption-service'
import { newIdempotencyKey, registerKey } from '../harness/keys'
import { ROUTES } from '../harness/protocol'
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
  if (validation.remoteState === 'unknown' || !validation.canWrite)
    throw new CloudKeySetupError(
      validation.message ?? 'Unable to unlock your chats.',
      validation.remoteState,
    )
  const { current } = validation
  // An account whose rows predate the registry registers the key as the one
  // that recovers them; the harness reseals only under the registered key.
  if (!current.key_id)
    await registerKey({
      keyB64: requirePrimaryKeyB64(),
      ifMatch: '*',
      createdVia: current.has_data ? 'recovery' : 'manual',
      idempotencyKey: newIdempotencyKey(),
    })
  if (!current.has_data) return
  // Only key candidates cross the connection. The service owns the migration job.
  const keys = [
    ...new Set([
      requirePrimaryKeyB64(),
      ...[
        encryptionService.getKey(),
        ...encryptionService.getStoredAlternatives(),
      ].flatMap((value) => {
        const bytes = value && encryptionService.getAlternativeKeyBytes(value)
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
    ROUTES.keysMigrateAll,
    { keys, target: { key: requirePrimaryKeyB64() } },
    { keyless: true },
  )
}
export async function registerStartFreshKeyIfNeeded() {
  const validation = await validateCurrentPrimaryKey()
  if (validation.remoteState === 'unknown')
    throw new CloudKeySetupError(validation.message, 'unknown')
  const { current } = validation
  if (current.key_id && validation.canWrite) return
  await registerKey({
    keyB64: requirePrimaryKeyB64(),
    ifMatch: current.etag || '*',
    createdVia: 'start_fresh',
    idempotencyKey: newIdempotencyKey(),
  })
}
