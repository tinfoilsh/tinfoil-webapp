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
export async function authorizeCurrentPrimaryKeyOrThrow(
  mode: CloudKeyAuthorizationMode = 'validated',
): Promise<void> {
  if (mode === 'explicit_start_fresh') {
    await registerStartFreshKeyIfNeeded()
    return
  }
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
        { key: requirePrimaryKeyB64() },
        ...[
          encryptionService.getKey(),
          ...encryptionService.getStoredAlternatives(),
        ].flatMap((value) => {
          const bytes = value && encryptionService.getAlternativeKeyBytes(value)
          if (!bytes) return []
          try {
            return [{ key: btoa(String.fromCharCode(...bytes)) }]
          } finally {
            bytes.fill(0)
          }
        }),
      ]
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
export async function authorizeCurrentPrimaryKey(
  mode: CloudKeyAuthorizationMode,
): Promise<boolean> {
  try {
    await authorizeCurrentPrimaryKeyOrThrow(mode)
    return true
  } catch {
    return false
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
