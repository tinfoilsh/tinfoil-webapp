import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'
import { z } from 'zod'

/**
 * Opengraph-metadata client.
 *
 * Fetches title/description/site_name/image for a URL
 * from the attested `opengraph-metadata.tinfoil.sh` enclave. Used by
 * the GenUI link-preview widget to replace model-generated fields with
 * verified values scraped server-side inside a Tinfoil CVM.
 */

const METADATA_ENCLAVE = 'https://opengraph-metadata.tinfoil.sh'
const METADATA_CONFIG_REPO = 'tinfoilsh/confidential-website-metadata-fetcher'
const nullableString = z.string().nullable()
const metadataResponseSchema = z.object({
  url: z.string(),
  title: nullableString,
  description: nullableString,
  site_name: nullableString,
  image: nullableString,
  cached: z.boolean(),
})

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
  cached: boolean
}

export class MetadataClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'HTTP_ERROR' | 'INVALID_RESPONSE',
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MetadataClientError'
  }
}

interface FaviconResponse {
  status: 'found' | 'missing'
  favicon_bytes: string
  favicon_content_type: string
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
const faviconPromiseByHost = new Map<string, Promise<string | null>>()

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

/** Fetch only a favicon without requesting the page through Zyte. */
export function fetchFavicon(url: string): Promise<string | null> {
  const key = faviconRequestKey(url)
  const existing = faviconPromiseByHost.get(key)
  if (existing) return existing

  const promise = doFetchFavicon(url).finally(() => {
    faviconPromiseByHost.delete(key)
  })
  faviconPromiseByHost.set(key, promise)
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
    throw new MetadataClientError(
      'Metadata service request failed',
      'HTTP_ERROR',
      response.status,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    const error = new MetadataClientError(
      'Metadata response failed validation',
      'INVALID_RESPONSE',
      response.status,
      { cause },
    )
    logError('Metadata response failed validation', error, {
      component: 'metadata-client',
      action: 'fetchLinkMetadata',
      metadata: { status: response.status },
    })
    throw error
  }

  const parsed = metadataResponseSchema.safeParse(body)
  if (!parsed.success) {
    const error = new MetadataClientError(
      'Metadata response failed validation',
      'INVALID_RESPONSE',
      response.status,
      { cause: parsed.error },
    )
    logError('Metadata response failed validation', error, {
      component: 'metadata-client',
      action: 'fetchLinkMetadata',
      metadata: { status: response.status },
    })
    throw error
  }

  const data = parsed.data
  return {
    url: data.url,
    title: trimmedOrNull(data.title),
    description: trimmedOrNull(data.description),
    siteName: trimmedOrNull(data.site_name),
    image: validHttpUrlOrNull(data.image),
    cached: data.cached,
  }
}

async function doFetchFavicon(url: string): Promise<string | null> {
  const response = await getClient().fetch(`${METADATA_ENCLAVE}/favicon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    logError(
      `Favicon fetch failed with status: ${response.status}`,
      undefined,
      {
        component: 'metadata-client',
        action: 'fetchFavicon',
        metadata: { status: response.status, error: errorText },
      },
    )
    throw new Error(`Favicon fetch failed: ${response.status}`)
  }

  const data: unknown = await response.json()
  if (!isFaviconResponse(data)) {
    throw new Error('Invalid favicon response')
  }
  if (data.status === 'missing') return null

  return buildFaviconDataUrl(data.favicon_bytes, data.favicon_content_type)
}

function isFaviconResponse(value: unknown): value is FaviconResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'found' || value.status === 'missing') &&
    'favicon_bytes' in value &&
    typeof value.favicon_bytes === 'string' &&
    'favicon_content_type' in value &&
    typeof value.favicon_content_type === 'string'
  )
}

function faviconRequestKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
}

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function validHttpUrlOrNull(value: string | null): string | null {
  const trimmed = trimmedOrNull(value)
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

function buildFaviconDataUrl(base64: string, contentType: string): string {
  const bytes = base64.trim()
  const type = contentType.trim()
  if (!bytes || !type.toLowerCase().startsWith('image/')) {
    throw new Error('Invalid found favicon response')
  }
  return `data:${type};base64,${bytes}`
}
