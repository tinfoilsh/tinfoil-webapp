/**
 * Only allow same-origin relative paths as post-auth redirect targets:
 * must start with a single '/', and must not contain backslashes, which
 * some URL parsers treat as path separators (enabling open redirects
 * like `/\evil.com`).
 */
export function sanitizeRelativeRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//')) return null
  if (value.includes('\\')) return null
  return value
}
