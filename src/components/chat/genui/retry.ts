export type ArtifactRetryErrorCode =
  | 'request_failed'
  | 'schema_conversion_failed'
  | 'incomplete_replacement'
  | 'schema_invalid_replacement'
  | 'stale_target'
  | 'unavailable_target'

export class ArtifactRetryError extends Error {
  readonly code: ArtifactRetryErrorCode

  constructor(code: ArtifactRetryErrorCode, options: { cause?: unknown } = {}) {
    super(code, { cause: options.cause })
    this.name = 'ArtifactRetryError'
    this.code = code
  }
}
