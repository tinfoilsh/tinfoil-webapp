import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

/**
 * Opengraph-metadata client.
 *
 * Fetches title/description/site_name/image/favicon-bytes for a URL
 * from the attested `opengraph-metadata.tinfoil.sh` enclave. Used by
 * the GenUI link-preview widget to replace model-generated fields with
 * verified values scraped server-side inside a Tinfoil CVM. Favicon
 * bytes are inlined in the response so the browser never has to make a
 * follow-up GET to an external icon host.
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
  faviconBytes: ArrayBuffer | null
  faviconContentType: string | null
  cached: boolean
}

interface MetadataResponse {
  url: string
  title: string | null
  description: string | null
  site_name: string | null
  image: string | null
  favicon_bytes?: string | null
  favicon_content_type?: string | null
  cached: boolean
}

/**
 * Module-level dedup map for in-flight metadata requests. Keyed by URL
 * so multiple `LinkPreview` instances for the same URL — or rapid
 * remounts — share a single attested round-trip instead of hammering
 * the enclave.
 *
 * Entries are removed once the request settles (success or failure) so
 * the map only ever holds promises that are actually in flight. This
 * keeps the dedup behavior intact for concurrent callers without
 * holding resolved results indefinitely (which would both serve stale
 * data and grow unbounded over a session).
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

  const promise = doFetchLinkMetadata(url).finally(() => {
    metadataPromiseByUrl.delete(url)
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
    faviconBytes: decodeBase64Bytes(data.favicon_bytes),
    faviconContentType: data.favicon_content_type ?? null,
    cached: data.cached,
  }
}

function decodeBase64Bytes(
  value: string | null | undefined,
): ArrayBuffer | null {
  if (!value) return null
  try {
    const binary = atob(value)
    const buffer = new ArrayBuffer(binary.length)
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return buffer
  } catch {
    return null
  }
}
