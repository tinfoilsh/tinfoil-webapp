/**
 * §9.6 R4 — Per-code recovery dispatch for the sync enclave.
 *
 * The §9.6 R2 classifier groups every observable failure into one of
 * four buckets; this module is the next step — for every code in
 * Appendix B of the sync spec, it returns the SINGLE concrete recovery
 * action the client must take. The dispatch is a pure static table so
 * adding a new error code requires a new row here, and tests can
 * enumerate every code to assert the mapping is exhaustive.
 *
 * Callers (cloud-storage, profile-sync, project-storage adapters; the
 * sync engine; the recovery UI driver) do NOT branch on error codes
 * themselves. They call:
 *
 *   const action = decideRecovery(err)
 *   switch (action.type) { ... }
 *
 * The handler for each `action.type` lives in the consumer (e.g.
 * `cloud-sync.ts` knows how to refresh-current-key + retry; the
 * recovery-modal driver knows how to surface a SYNC_CONFLICT). That
 * keeps the recovery table free of any UI / state-machine logic.
 */

import {
  classifyEnclaveError,
  type EnclaveErrorClassification,
  type EnclaveErrorCode,
} from './enclave-error-classification'

/**
 * Discriminated union of recovery actions. Every variant carries the
 * minimum context a handler needs to act (the original classified
 * error so the handler can log it, plus any structured hints from the
 * enclave response such as `current_etag` / `current_key_id`).
 */
export type RecoveryAction =
  /**
   * Network blip / 5xx / refreshable auth. Retry the SAME logical
   * write under the SAME idempotency key, using the §9.6 R3 backoff
   * helper. The classification's `code` field tells the caller what
   * pre-retry hook to run (refresh JWT for AUTH, nothing for the
   * rest).
   */
  | { type: 'retry'; reason: 'NETWORK' | 'TRANSIENT_5XX' | 'AUTH_REFRESH' }
  /**
   * Local state is stale. Refresh the local view of either the
   * current key id or the row etag, then retry the write as a NEW
   * logical write (new idempotency key) because the canonical tuple
   * has changed.
   */
  | { type: 'refresh-current-key-and-retry' }
  | { type: 'pull-and-retry'; reason: 'STALE_BLOB' | 'NEEDS_REWRAP' }
  /**
   * Targeted blob migration before the read can succeed. The
   * recovery driver runs `/v1/blobs/migrate` for the scope and then
   * the caller retries the original pull.
   */
  | { type: 'migrate-legacy-and-retry'; scope?: string }
  /**
   * User input required. Surface the conflict UI / register-key
   * arbitration; no automatic retry.
   */
  | { type: 'surface-conflict'; reason: 'SYNC_CONFLICT' }
  | { type: 'surface-existing-data-under-other-key' }
  /**
   * Local key is wrong. Trigger the recovery wizard (passkey /
   * manual-key / start-fresh).
   */
  | { type: 'trigger-recovery-wizard'; reason: 'UNKNOWN_KEY' }
  /**
   * The enclave attestation is broken. Stop all sync, surface a
   * blocking banner. Never silently fall back to a legacy path.
   */
  | { type: 'block-all-sync'; reason: 'ATTESTATION_FAILED' }
  /**
   * Caller bug. Log + surface a generic "something went wrong" to
   * the user, then drop the operation. Retrying under the same key
   * would 409 again.
   */
  | { type: 'abort'; reason: 'IDEMPOTENCY_CONFLICT' | 'FORBIDDEN' | 'UNKNOWN' }

export interface RecoveryDecision {
  action: RecoveryAction
  classification: EnclaveErrorClassification
}

/**
 * Decide the recovery action for any thrown value from the sync
 * enclave path. Idempotent and pure; safe to call inside a `catch`
 * before any side effects.
 */
export function decideRecovery(err: unknown): RecoveryDecision {
  const classification = classifyEnclaveError(err)
  return {
    classification,
    action: actionFor(classification),
  }
}

function actionFor(c: EnclaveErrorClassification): RecoveryAction {
  if (c.code) {
    return ACTIONS[c.code](c)
  }
  switch (c.kind) {
    case 'RETRYABLE_TRANSIENT':
      return { type: 'retry', reason: 'TRANSIENT_5XX' }
    case 'RETRYABLE_REFRESH':
      // Unreachable in practice (RETRYABLE_REFRESH only arises with a
      // code), but the type system wants exhaustiveness.
      return { type: 'pull-and-retry', reason: 'STALE_BLOB' }
    case 'USER_DECISION':
    case 'TERMINAL':
      return { type: 'abort', reason: 'UNKNOWN' }
  }
}

/**
 * One row per Appendix B code. The table is intentionally NOT a
 * `switch` so the test in §14 #13 can enumerate `keyof typeof ACTIONS`
 * and assert every code is present.
 */
const ACTIONS: Record<
  EnclaveErrorCode,
  (_: EnclaveErrorClassification) => RecoveryAction
> = {
  STALE_KEY: () => ({ type: 'refresh-current-key-and-retry' }),
  STALE_BLOB: () => ({ type: 'pull-and-retry', reason: 'STALE_BLOB' }),
  SYNC_CONFLICT: () => ({
    type: 'surface-conflict',
    reason: 'SYNC_CONFLICT',
  }),
  IDEMPOTENCY_CONFLICT: () => ({
    type: 'abort',
    reason: 'IDEMPOTENCY_CONFLICT',
  }),
  EXISTING_DATA_UNDER_OTHER_KEY: () => ({
    type: 'surface-existing-data-under-other-key',
  }),
  UNKNOWN_KEY: () => ({
    type: 'trigger-recovery-wizard',
    reason: 'UNKNOWN_KEY',
  }),
  LEGACY_BLOB_NOT_MIGRATED: () => ({
    type: 'migrate-legacy-and-retry',
  }),
  ATTESTATION_FAILED: () => ({
    type: 'block-all-sync',
    reason: 'ATTESTATION_FAILED',
  }),
  AUTH: () => ({ type: 'retry', reason: 'AUTH_REFRESH' }),
  FORBIDDEN: () => ({ type: 'abort', reason: 'FORBIDDEN' }),
  NETWORK: () => ({ type: 'retry', reason: 'NETWORK' }),
}

/**
 * Exposed so the §14 #13 test can iterate the table without exporting
 * the function values.
 */
export const COVERED_CODES = Object.keys(ACTIONS) as EnclaveErrorCode[]
