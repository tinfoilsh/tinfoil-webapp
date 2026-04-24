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
 * Module-level dedup map for in-flight metadata requests. Keyed by URL
 * so multiple `LinkPreview` instances for the same URL — or rapid
 * remounts — share a single attested round-trip instead of hammering
 * the enclave.
 */
const metadataPromiseByUrl = new Map<string, Promise<LinkMetadata>>()

/**
 * Fetch OpenGraph metadata for a URL from the Tinfoil enclave.
 *
 * Throws on non-2xx responses so callers can fall back to their local
 * (model-provided) values. Attestation is verified by the underlying
 * `SecureClient` — a verification failure surfaces as a thrown error.
 *
 * In-flight requests for the same URL are deduplicated.
 */
export function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const existing = metadataPromiseByUrl.get(url)
  if (existing) return existing

  const promise = doFetchLinkMetadata(url).catch((err) => {
    metadataPromiseByUrl.delete(url)
    throw err
  })
  metadataPromiseByUrl.set(url, promise)
  return promise
}

async function doFetchLinkMetadata(url: string): Promise<LinkMetadata> {
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

function getHostKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Build a direct `<img src>` URL pointing at the enclave's lightweight
 * `GET /favicon?host=...` endpoint.
 *
 * The browser loads the bytes in a single request. No JSON round-trip,
 * no async state in the UI. The enclave proxies to DuckDuckGo's icon
 * service server-side so the browser never talks to DuckDuckGo directly.
 *
 * Returns `null` for URLs whose hostname cannot be parsed.
 */
export function getFaviconUrl(url: string): string | null {
  const host = getHostKey(url)
  if (!host) return null
  return `${METADATA_ENCLAVE}/favicon?host=${encodeURIComponent(host)}`
}
