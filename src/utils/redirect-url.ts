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

const MESSAGE_QUERY_PARAM = 'q'
const MESSAGE_HASH_PREFIX = '#send='

/**
 * Removes the `?q=` and `#send=` prefill markers from a relative path. Those
 * carry message text, so they must not be forwarded through sign-in links or
 * any other URL that leaves the page.
 */
export function stripMessageMarkers(relativePath: string): string {
  const url = new URL(relativePath, 'http://placeholder')
  url.searchParams.delete(MESSAGE_QUERY_PARAM)
  if (url.hash.startsWith(MESSAGE_HASH_PREFIX)) url.hash = ''
  return url.pathname + url.search + url.hash
}

/**
 * Builds the `redirect_url` value for sign-in and sign-up links so the user
 * returns to their current page after authenticating, minus any prefilled
 * message.
 */
export function postAuthRedirectTarget(asPath: string): string {
  return encodeURIComponent(stripMessageMarkers(asPath))
}
