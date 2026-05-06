/**
 * GenUI input coercion helpers.
 *
 * Models sometimes emit nested arrays/objects as stringified JSON instead of
 * true arrays/objects. These helpers coerce input so components can accept
 * either shape without loosening their Zod schema.
 */

export type ChartRow = Record<string, string | number>

/**
 * Coerce a value into an array. Accepts:
 * - a real array → returned as-is
 * - a JSON-encoded array string → parsed
 * Returns an empty array on any parse/shape mismatch.
 */
export function coerceArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed as T[]
    } catch {
      // fall through
    }
  }
  return []
}

/**
 * Coerce a value into an object. Accepts:
 * - a real object → returned as-is
 * - a JSON-encoded object string → parsed
 * Returns an empty object on any parse/shape mismatch.
 */
export function coerceObject<T extends Record<string, unknown>>(
  value: unknown,
): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T
      }
    } catch {
      // fall through
    }
  }
  return {} as T
}

/** True if `value` is (or decodes to) a non-empty array. */
export function isNonEmptyArray(value: unknown): boolean {
  return coerceArray(value).length > 0
}
