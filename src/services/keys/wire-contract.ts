/**
 * Canonical TypeScript mirror of the Go wire contract defined in
 * github.com/tinfoilsh/controlplane/pkg/contract (sentinels.go), limited to
 * the values the key registration flow sends, plus the error code the harness
 * returns when the key registry refuses a key.
 *
 * The harness passes the sentinels to the controlplane as sent, so they are
 * a cross-repo wire contract; renaming any of them is a wire break. Error
 * codes are the harness's own (DownstreamError in
 * confidential-tinfoil-harness/internal/api/errors.go).
 *
 * Source of truth (do not edit independently):
 *   - controlplane/pkg/contract/sentinels.go
 *   - confidential-tinfoil-harness/internal/api/errors.go
 */

/** Sentinel If-Match values; see controlplane/pkg/contract/sentinels.go. */
export const IF_MATCH_SENTINELS = {
  /** "Any key" — succeeds only if no key is registered for the user. */
  AnyKey: '*',
} as const

/** Error codes the harness returns for key requests. */
export const HARNESS_KEY_CODES = {
  /**
   * Data is stored under another key. The harness reports the
   * controlplane's EXISTING_DATA_UNDER_OTHER_KEY, STALE_KEY and UNKNOWN_KEY
   * codes this way.
   */
  KeyMismatch: 'KEY_MISMATCH',
} as const
