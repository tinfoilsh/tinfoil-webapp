/**
 * Layer B of the sync-enclave refactor.
 *
 * Drives the enclave's `/v1/blobs/migrate-all` endpoint to re-seal
 * every legacy (v0/v1) row under the current primary CEK. Without
 * this loop, dropping `KeyBundle.alternatives` (Layer C) would
 * silently strand any row that needs an old key to unseal — the
 * §9.6 R5 health bucket would mark them LOST.
 *
 * Pagination lives entirely inside the enclave. The client makes one
 * call; if the enclave hits its wall-clock budget before draining
 * every scope it sets `partial: true` and we re-invoke once to pick
 * up where it left off. Two passes is sufficient to bound the
 * client-side blast radius without papering over an infinite loop
 * on an enclave-side regression.
 *
 * The candidate-key set is `migrationKeys()`: primary first, then
 * every alternative the client still holds. The steady-state read
 * path uses `pullKey()` (primary only) so historical CEKs are only
 * shipped to the enclave on this one path that actually needs them.
 * The target is always the current primary CEK — even when nothing
 * rotates, the operation is a no-op for rows already sealed under
 * the primary.
 */

import { logError, logInfo } from '@/utils/error-handling'
import { encryptionService } from '../encryption/encryption-service'
import {
  migrateAll as enclaveMigrateAll,
  migrateStatus as enclaveMigrateStatus,
  type MigrateAllResponse,
  type MigrateAllScopeReport,
  type Scope,
} from '../sync-enclave/sync-api'
import { migrationKeys, requirePrimaryKeyB64 } from './cek-encoding'

const MIGRATION_POLL_INTERVAL_MS = 2_000
const MIGRATION_POLL_TIMEOUT_MS = 15 * 60_000
/** Terminal coordinator status for a job that died mid-run. */
const FAILED_JOB_STATUS = 'failed'

export interface ScopeMigrationResult {
  scope: Scope
  migrated: number
  remaining: number
  blockedUnmigrated: number
  blocked: string[]
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

function emptyReport(): MigrationReport {
  return {
    scopes: [],
    totalMigrated: 0,
    totalRemaining: 0,
    totalBlocked: 0,
    fullyMigrated: false,
  }
}

function snapshotScopeReports(
  incoming: readonly MigrateAllScopeReport[],
): Map<Scope, ScopeMigrationResult> {
  const acc = new Map<Scope, ScopeMigrationResult>()
  for (const s of incoming) {
    acc.set(s.scope, {
      scope: s.scope,
      migrated: s.migrated,
      remaining: s.retryable_remaining,
      blockedUnmigrated: s.blocked_unmigrated,
      blocked: s.blocked ?? [],
    })
  }
  return acc
}

function toReport(scopes: Map<Scope, ScopeMigrationResult>): MigrationReport {
  const list = [...scopes.values()]
  const totalMigrated = list.reduce((sum, r) => sum + r.migrated, 0)
  const totalRemaining = list.reduce((sum, r) => sum + r.remaining, 0)
  const totalBlocked = list.reduce((sum, r) => sum + r.blockedUnmigrated, 0)
  return {
    scopes: list,
    totalMigrated,
    totalRemaining,
    totalBlocked,
    fullyMigrated: totalRemaining === 0,
  }
}

/**
 * Run the enclave-driven migration. Kicks off the detached
 * migration job, then polls migrate-status until the job reaches a
 * terminal state. Survives tab close on the enclave side: closing
 * the tab cancels this polling loop but the job keeps draining on
 * the enclave; the next sync attempt picks up the in-flight job
 * via the same coordinator and resumes polling.
 */
export async function runLegacyBlobMigration(): Promise<MigrationReport> {
  const target = { key: requirePrimaryKeyB64() }
  const keys = migrationKeys()
  const startedAt = Date.now()

  let lastResp: MigrateAllResponse | undefined
  try {
    lastResp = await enclaveMigrateAll({ keys, target })
  } catch (err) {
    logError('legacy-blob-migration: enclave migrate-all kickoff failed', err, {
      component: 'LegacyBlobMigration',
      action: 'runLegacyBlobMigration',
    })
    return emptyReport()
  }

  while (lastResp?.partial && (lastResp.status ?? 'running') === 'running') {
    if (Date.now() - startedAt > MIGRATION_POLL_TIMEOUT_MS) {
      break
    }
    await sleep(MIGRATION_POLL_INTERVAL_MS)
    try {
      lastResp = await enclaveMigrateStatus()
    } catch (err) {
      logError('legacy-blob-migration: enclave migrate-status failed', err, {
        component: 'LegacyBlobMigration',
        action: 'runLegacyBlobMigration',
      })
      break
    }
  }

  const snapshot = lastResp ? snapshotScopeReports(lastResp.scopes) : new Map()
  const report = toReport(snapshot)
  // A failed coordinator job can report partial=false: the flag
  // starts false and only flips when the run hits its budget, so a
  // job that dies before any scope makes progress finishes as
  // status=failed + partial=false with empty scopes. Treating that
  // as a clean drain would clear the alternative keys after nothing
  // was rewrapped, stranding every legacy row.
  const jobFailed = lastResp?.status === FAILED_JOB_STATUS
  if (lastResp?.partial !== false || jobFailed) {
    report.fullyMigrated = false
  }
  logInfo('legacy-blob-migration complete', {
    component: 'LegacyBlobMigration',
    action: 'runLegacyBlobMigration',
    metadata: {
      status: lastResp?.status,
      totalMigrated: report.totalMigrated,
      totalRemaining: report.totalRemaining,
      totalBlocked: report.totalBlocked,
      partial: lastResp?.partial ?? false,
    },
  })
  // Three terminal states:
  //   1. We never got a response (network/enclave failure) — lastResp
  //      is undefined. Return emptyReport with fullyMigrated:false so
  //      Layer C does not drop alternatives on a failed pass.
  //   2. We got a final response with no scopes (a freshly-keyed user
  //      has nothing to migrate) — snapshot is empty BUT lastResp
  //      is defined with partial:false. This is success; Layer C must
  //      be allowed to clear alternatives.
  //   3. Normal case — snapshot has entries; trust `toReport`.
  if (snapshot.size === 0) {
    if (lastResp && !lastResp.partial && !jobFailed) {
      return { ...emptyReport(), fullyMigrated: true }
    }
    return emptyReport()
  }
  return report
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Layer C cleanup. Once the migration reports `fullyMigrated`, every
 * row the enclave can read is sealed under the current primary CEK,
 * so the local alternative-keys list is no longer required for any
 * read path. Clear it from memory and from the persisted history
 * bucket. The remote passkey bundle is NOT rewritten here — the next
 * passkey ceremony picks up the now-empty `alternatives` from
 * `encryptionService.getAllKeys()` and re-stores the bundle
 * naturally, with no extra ceremony required.
 *
 * Idempotent and a no-op when `report.fullyMigrated` is false.
 * Returns true when the local state was cleared (or already empty).
 */
export function finalizeAlternativesIfMigrated(
  report: MigrationReport,
): boolean {
  if (!report.fullyMigrated) {
    return false
  }
  const before = encryptionService.getFallbackKeyCount()
  encryptionService.clearFallbackKeys()
  logInfo('Cleared alternative keys after enclave migration', {
    component: 'LegacyBlobMigration',
    action: 'finalizeAlternativesIfMigrated',
    metadata: {
      cleared: before,
      totalMigrated: report.totalMigrated,
      totalBlocked: report.totalBlocked,
    },
  })
  return true
}

/**
 * Convenience: run the migration and, on success, drop the
 * client-side alternatives. Returns the report so callers can still
 * surface counts to the UI.
 */
export async function runLegacyBlobMigrationAndFinalize(): Promise<MigrationReport> {
  const report = await runLegacyBlobMigration()
  finalizeAlternativesIfMigrated(report)
  return report
}
