/**
 * Validates a JWT token by checking its expiration time and not-before time.
 * Returns true if the token is valid and not expired.
 *
 * Clerk JWTs include:
 * - exp (expiration time): seconds since epoch when token expires
 * - nbf (not before): seconds since epoch when token becomes valid
 * - iat (issued at): seconds since epoch when token was issued
 */
export function isTokenValid(token: string | null): boolean {
  if (!token) return false

  try {
    // JWT tokens have 3 parts separated by dots: header.payload.signature
    const parts = token.split('.')
    if (parts.length !== 3) return false

    // Decode the payload (second part) - it's base64url encoded
    const payload = parts[1]
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    )

    const nowSeconds = Math.floor(Date.now() / 1000)
    // Add a 30-second buffer before expiration to avoid race conditions
    const bufferSeconds = 30

    // Check expiration (exp claim) - token must not be expired
    if (decoded.exp && decoded.exp < nowSeconds + bufferSeconds) {
      return false
    }

    // Check not-before (nbf claim) - token must be valid now
    if (decoded.nbf && decoded.nbf > nowSeconds) {
      return false
    }

    return true
  } catch {
    // If we can't decode the token, assume it's invalid
    return false
  }
}
