/**
 * Apple MapKit JS token client.
 *
 * Fetches short-lived ES256 JWTs from the controlplane's
 * `/api/mapkit/token` endpoint. The endpoint is public (unauthenticated)
 * because Apple's MapKit JS CDN enforces the JWT's `origin` claim — leaked
 * tokens cannot be used off-origin.
 *
 * The module-level cache returns the same token across the page until it
 * is close to expiring, and an in-flight promise deduplicates concurrent
 * requests (mirrors the enclave-metadata fetch pattern).
 */
import { logError } from '@/utils/error-handling'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

// Refresh ahead of expiry so we never hand MapKit a token Apple is about
// to reject.
const REFRESH_BUFFER_SECONDS = 60

interface CachedToken {
  token: string
  expiresAt: number
}

let cached: CachedToken | null = null
let inflight: Promise<string> | null = null

export async function getMapKitToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expiresAt - REFRESH_BUFFER_SECONDS > now) {
    return cached.token
  }
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/mapkit/token`)
      if (!res.ok) {
        throw new Error(`mapkit token request failed: ${res.status}`)
      }
      const body = (await res.json()) as {
        token: string
        expiresAt: number
      }
      cached = { token: body.token, expiresAt: body.expiresAt }
      return body.token
    } catch (error) {
      logError('Failed to fetch MapKit token', error, {
        component: 'MapKitToken',
        action: 'getMapKitToken',
      })
      throw error
    } finally {
      inflight = null
    }
  })()

  return inflight
}
