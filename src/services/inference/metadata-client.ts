import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

/**
 * Opengraph-metadata client.
 *
 * Fetches title/description/site_name/image/favicon for a URL from the
 * attested `opengraph-metadata.tinfoil.sh` enclave. Used by the GenUI
 * link-preview widget to replace model-generated fields with verified
 * values scraped server-side inside a Tinfoil CVM.
 */

const METADATA_ENCLAVE = 'https://opengraph-metadata.tinfoil.sh'
const METADATA_CONFIG_REPO = 'tinfoilsh/confidential-website-metadata-fetcher'

let cachedClient: SecureClient | null = null

function getClient(): SecureClient {
  if (!cachedClient) {
    cachedClient = new SecureClient({
      enclaveURL: METADATA_ENCLAVE,
      configRepo: METADATA_CONFIG_REPO,
    })
  }
  return cachedClient
}

export interface LinkMetadata {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  image: string | null
  favicon: string | null
  cached: boolean
}

interface MetadataResponse {
  url: string
  title: string | null
  description: string | null
  site_name: string | null
  image: string | null
  favicon: string | null
  cached: boolean
}

/**
 * Fetch OpenGraph metadata for a URL from the Tinfoil enclave.
 *
 * Throws on non-2xx responses so callers can fall back to their local
 * (model-provided) values. Attestation is verified by the underlying
 * `SecureClient` — a verification failure surfaces as a thrown error.
 */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const client = getClient()

  const response = await client.fetch(`${METADATA_ENCLAVE}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    logError(
      `Metadata fetch failed with status: ${response.status}`,
      undefined,
      {
        component: 'metadata-client',
        action: 'fetchLinkMetadata',
        metadata: {
          status: response.status,
          error: errorText,
        },
      },
    )
    throw new Error(`Metadata fetch failed: ${response.status}`)
  }

  const data: MetadataResponse = await response.json()
  return {
    url: data.url,
    title: data.title,
    description: data.description,
    siteName: data.site_name,
    image: data.image,
    favicon: data.favicon,
    cached: data.cached,
  }
}

/**
 * Module-level dedup cache for favicon lookups. Keyed by hostname so
 * multiple mentions of the same domain across a page share a single
 * in-flight enclave request and a single stored result.
 */
const faviconPromiseByHost = new Map<string, Promise<string | null>>()

function getHostKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Resolve the favicon for a URL's host via the attested metadata enclave.
 *
 * Returns `null` when the page exposes no favicon or the fetch fails.
 * Requests are deduplicated by hostname so a chat view with dozens of
 * links from the same domain only pays for one attested round-trip.
 */
export function fetchFavicon(url: string): Promise<string | null> {
  const host = getHostKey(url)
  if (!host) return Promise.resolve(null)
  const existing = faviconPromiseByHost.get(host)
  if (existing) return existing

  // Normalize to the hostname root so every per-URL call hits the same
  // cache key. This trades a potentially-different per-page favicon for
  // drastically fewer enclave requests, which is the right tradeoff for a
  // favicon thumbnail.
  const lookupUrl = `https://${host}/`
  const promise = fetchLinkMetadata(lookupUrl)
    .then((m) => m.favicon)
    .catch(() => null)
  faviconPromiseByHost.set(host, promise)
  return promise
}
