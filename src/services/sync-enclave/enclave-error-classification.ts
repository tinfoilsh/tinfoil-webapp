/**
 * §9.6 R2 — Error classification for sync-enclave failures.
 *
 * Every failure observable to client code that talks to the sync
 * enclave (or to the cloud-storage / profile-sync / project-storage
 * adapters that wrap it) is mapped to exactly one bucket by this
 * function. The bucket determines the caller's recovery action,
 * documented per-bucket below and exercised by the recovery table in
 * §9.6 R4.
 *
 * Catch blocks in `src/services/cloud/**` and the sync hooks
 * (`use-cloud-sync`, `use-passkey-backup`) MUST either re-throw or
 * route the error through `classifyEnclaveError` — bare empty
 * `catch {}` blocks are banned (lint-enforced) so silent failures
 * cannot leak into the client.
 */

import { SyncEnclaveError } from './sync-enclave-client'

/**
 * Four buckets the rest of the client recovers against.
 *
 *   RETRYABLE_TRANSIENT — Network blip, 5xx, expired-JWT-with-refresh.
 *                         Caller should retry under the SAME idempotency
 *                         key with the §9.6 R3 backoff helper.
 *   RETRYABLE_REFRESH   — STALE_KEY. The canonical key tuple is
 *                         outdated; caller should refresh
 *                         current_key_id and retry with a NEW
 *                         idempotency key.
 *   USER_DECISION       — SYNC_CONFLICT, STALE_BLOB,
 *                         EXISTING_DATA_UNDER_OTHER_KEY. Server cannot
 *                         decide automatically; surface to the
 *                         recovery / conflict UI and wait for explicit
 *                         user input. (STALE_BLOB should normally be
 *                         re-mapped to SYNC_CONFLICT by the enclave;
 *                         the entry here is defensive in case a raw
 *                         code escapes.)
 *   TERMINAL            — FORBIDDEN, IDEMPOTENCY_CONFLICT, UNKNOWN_KEY,
 *                         ATTESTATION_FAILED, malformed responses, and
 *                         every otherwise-unmapped error. The caller
 *                         must stop trying and surface a specific UI
 *                         error to the user.
 */
export type EnclaveErrorKind =
  | 'RETRYABLE_TRANSIENT'
  | 'RETRYABLE_REFRESH'
  | 'USER_DECISION'
  | 'TERMINAL'

/**
 * The Appendix B code strings the enclave returns. A small string
 * union (rather than `string`) so misspellings fail typecheck and the
 * §9.6 R4 recovery table is forced to enumerate every value.
 */
export type EnclaveErrorCode =
  | 'STALE_KEY'
  | 'STALE_BLOB'
  | 'SYNC_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXISTING_DATA_UNDER_OTHER_KEY'
  | 'UNKNOWN_KEY'
  | 'LEGACY_BLOB_NOT_MIGRATED'
  | 'ATTESTATION_FAILED'
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'NOT_FOUND'

export interface EnclaveErrorClassification {
  kind: EnclaveErrorKind
  /** Canonical Appendix B code when one applies. */
  code?: EnclaveErrorCode
  /** Raw HTTP status, if available. */
  status?: number
  /** Free-form message safe to render in logs (NOT to the user). */
  message: string
  /** Original error preserved for the recovery table to inspect. */
  cause: unknown
}

/**
 * Classify any thrown value as one of the four §9.6 R2 buckets. The
 * function never throws; an unrecognized error becomes TERMINAL so
 * silent recovery cannot happen by accident.
 */
export function classifyEnclaveError(err: unknown): EnclaveErrorClassification {
  if (err instanceof SyncEnclaveError) {
    return classifySyncEnclaveError(err)
  }

  if (isNetworkError(err)) {
    return {
      kind: 'RETRYABLE_TRANSIENT',
      code: 'NETWORK',
      message: errorMessage(err),
      cause: err,
    }
  }

  if (isAttestationError(err)) {
    return {
      kind: 'TERMINAL',
      code: 'ATTESTATION_FAILED',
      message: errorMessage(err),
      cause: err,
    }
  }

  return {
    kind: 'TERMINAL',
    message: errorMessage(err),
    cause: err,
  }
}

function classifySyncEnclaveError(
  err: SyncEnclaveError,
): EnclaveErrorClassification {
  const code = err.code as EnclaveErrorCode | undefined
  const message = err.message
  const status = err.status

  if (code) {
    switch (code) {
      case 'STALE_KEY':
        return {
          kind: 'RETRYABLE_REFRESH',
          code,
          status,
          message,
          cause: err,
        }
      case 'SYNC_CONFLICT':
      case 'STALE_BLOB':
      case 'EXISTING_DATA_UNDER_OTHER_KEY':
      case 'NOT_FOUND':
        return { kind: 'USER_DECISION', code, status, message, cause: err }
      case 'IDEMPOTENCY_CONFLICT':
      case 'UNKNOWN_KEY':
      case 'FORBIDDEN':
      case 'ATTESTATION_FAILED':
        return { kind: 'TERMINAL', code, status, message, cause: err }
      case 'LEGACY_BLOB_NOT_MIGRATED':
        // The recovery table runs targeted /v1/blobs/migrate and
        // retries the read with the same logical-write intent, so
        // semantically this is a "refresh and retry" path.
        return {
          kind: 'RETRYABLE_REFRESH',
          code,
          status,
          message,
          cause: err,
        }
      case 'AUTH':
        // The JWT can almost always be refreshed by the auth layer
        // (Clerk SDK handles renewal). Caller retries under the same
        // idempotency key after a token refresh.
        return {
          kind: 'RETRYABLE_TRANSIENT',
          code,
          status,
          message,
          cause: err,
        }
      case 'NETWORK':
        return {
          kind: 'RETRYABLE_TRANSIENT',
          code,
          status,
          message,
          cause: err,
        }
    }
  }

  if (status !== undefined) {
    if (status >= 500 && status < 600) {
      return {
        kind: 'RETRYABLE_TRANSIENT',
        status,
        message,
        cause: err,
      }
    }
    if (status === 401) {
      return {
        kind: 'RETRYABLE_TRANSIENT',
        code: 'AUTH',
        status,
        message,
        cause: err,
      }
    }
    if (status === 403) {
      return {
        kind: 'TERMINAL',
        code: 'FORBIDDEN',
        status,
        message,
        cause: err,
      }
    }
    if (status === 404) {
      return {
        kind: 'USER_DECISION',
        code: 'NOT_FOUND',
        status,
        message,
        cause: err,
      }
    }
  }

  return { kind: 'TERMINAL', status, message, cause: err }
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    // The browser's fetch surface throws TypeError on transport
    // failures (DNS, TLS, ECONNREFUSED, offline).
    return /network|fetch|failed to fetch/i.test(err.message)
  }
  return false
}

function isAttestationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // The bare token `verify` was too broad — it matched generic
  // strings like "failed to verify token". Match only phrases the
  // attestation layer actually emits: anything containing
  // "attestation", or the specific "enclave verification" /
  // "verification document" / "verifier" phrases that the
  // SecureClient surface uses.
  return /attestation|enclave verification|verification document|verifier/i.test(
    err.message,
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
