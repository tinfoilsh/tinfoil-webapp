/**
 * Layer B of the sync-enclave refactor.
 *
 * Drives the enclave's `/v1/blobs/migrate` endpoint to re-seal every
 * legacy (v0/v1) row under the current primary CEK. Without this
 * loop, dropping `KeyBundle.alternatives` (Layer C) would silently
 * strand any row that needs an old key to unseal — the §9.6 R5
 * health bucket would mark them LOST.
 *
 * Migration runs scope-by-scope. Each call processes up to
 * `MIGRATE_BATCH_LIMIT` rows; we loop until the enclave reports
 * `retryable_remaining === 0`. The `blocked` list (rows the enclave
 * could not unseal under any supplied key) is surfaced verbatim so
 * the caller can decide whether to flag them as LOST or retry later
 * with a recovered key.
 *
 * The candidate-key set is exactly what `pullKeysFromEncryptionService`
 * already builds for the read path: primary first, then every
 * alternative the client still holds. The target is always the
 * current primary CEK — even when nothing rotates, the operation is
 * a no-op for rows already sealed under the primary.
 */

import { logError, logInfo } from '@/utils/error-handling'
import {
  migrate as enclaveMigrate,
  type MigrateResponse,
  type Scope,
} from '../sync-enclave/sync-api'
import {
  pullKeysFromEncryptionService,
  requirePrimaryKeyB64,
} from './cek-encoding'

const MIGRATE_BATCH_LIMIT = 100
const MIGRATE_MAX_BATCHES_PER_SCOPE = 50

const MIGRATABLE_SCOPES: readonly Scope[] = [
  'profile',
  'chat',
  'project',
  'project_document',
] as const

export interface ScopeMigrationResult {
  scope: Scope
  migrated: number
  remaining: number
  blocked: string[]
  batches: number
}

export interface MigrationReport {
  scopes: ScopeMigrationResult[]
  totalMigrated: number
  totalRemaining: number
  totalBlocked: number
  /**
   * True when every scope reports `remaining === 0`. Layer C reads
   * this flag to decide whether it is safe to drop alternatives.
   * Blocked rows are NOT counted as remaining: the enclave cannot
   * unseal them under any supplied key, so further iterations would
   * not help — the caller must surface them as LOST instead.
   */
  fullyMigrated: boolean
}

/**
 * Run the migration loop for a single scope. Stops when the enclave
 * reports no retryable rows, the batch budget is exhausted, or the
 * batch returns zero progress (defensive — protects against an
 * enclave-side regression that would otherwise spin forever).
 */
async function migrateScope(scope: Scope): Promise<ScopeMigrationResult> {
  const target = { key: requirePrimaryKeyB64() }
  const keys = pullKeysFromEncryptionService()

  let migrated = 0
  let remaining = 0
  const blocked: string[] = []
  let batches = 0

  for (let i = 0; i < MIGRATE_MAX_BATCHES_PER_SCOPE; i++) {
    let resp: MigrateResponse
    try {
      resp = await enclaveMigrate({
        scope,
        keys,
        target,
        limit: MIGRATE_BATCH_LIMIT,
      })
    } catch (err) {
      logError(
        `legacy-blob-migration: enclave migrate failed for scope=${scope}`,
        err,
        {
          component: 'LegacyBlobMigration',
          action: 'migrateScope',
          metadata: { scope, batch: i },
        },
      )
      break
    }
    batches += 1
    migrated += resp.migrated
    remaining = resp.retryable_remaining
    if (resp.blocked.length > 0) {
      blocked.push(...resp.blocked)
    }
    if (resp.migrated === 0) break
    if (remaining === 0) break
  }

  logInfo(`legacy-blob-migration scope=${scope} complete`, {
    component: 'LegacyBlobMigration',
    action: 'migrateScope',
    metadata: { scope, migrated, remaining, blocked: blocked.length, batches },
  })

  return { scope, migrated, remaining, blocked, batches }
}

/**
 * Run the migration loop across every scope the enclave knows about.
 * Returns an aggregate report whose `fullyMigrated` flag is the
 * Layer C trigger.
 */
export async function runLegacyBlobMigration(): Promise<MigrationReport> {
  const results: ScopeMigrationResult[] = []
  for (const scope of MIGRATABLE_SCOPES) {
    results.push(await migrateScope(scope))
  }
  const totalMigrated = results.reduce((sum, r) => sum + r.migrated, 0)
  const totalRemaining = results.reduce((sum, r) => sum + r.remaining, 0)
  const totalBlocked = results.reduce((sum, r) => sum + r.blocked.length, 0)
  return {
    scopes: results,
    totalMigrated,
    totalRemaining,
    totalBlocked,
    fullyMigrated: totalRemaining === 0,
  }
}
