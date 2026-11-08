import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import { ROUTES, invalidResponse } from './protocol'
import { harnessAPI, type HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { RemoteImage } from './types'

const MAX_IMAGE_BYTES = 8 << 20
const MAX_ENCODED_IMAGE_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const IMAGE_CACHE_BYTES = 32 << 20
const IMAGE_CACHE_ENTRIES = 64
const IMAGE_CACHE_TTL_MS = 5 * 60_000
const IMAGE_CONCURRENCY = 4
const ARTIFACT_IMAGE_CONCURRENCY = 1
const MAX_IMAGE_URL_LENGTH = 8192
const PNG_TYPE = 'image/png'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i

interface ImageCache {
  ready: LRUCache<string, string>
  pending: Record<ImageQueue, Map<string, Promise<string>>>
  limit: Record<ImageQueue, ReturnType<typeof pLimit>>
}

type ImageQueue = 'chat' | 'artifact'

const caches = new WeakMap<HarnessAPI, ImageCache>()

export function localImageSource(src: string | undefined): string | undefined {
  return src && (INLINE_IMAGE.test(src) || src.startsWith('blob:'))
    ? src
    : undefined
}

function cacheFor(api: HarnessAPI): ImageCache {
  let cache = caches.get(api)
  if (!cache) {
    const ready = new LRUCache<string, string>({
      max: IMAGE_CACHE_ENTRIES,
      maxSize: IMAGE_CACHE_BYTES,
      ttl: IMAGE_CACHE_TTL_MS,
      sizeCalculation: (value, key) => (value.length + key.length) * 2,
    })
    cache = {
      ready,
      pending: { chat: new Map(), artifact: new Map() },
      limit: {
        chat: pLimit(IMAGE_CONCURRENCY),
        artifact: pLimit(ARTIFACT_IMAGE_CONCURRENCY),
      },
    }
    caches.set(api, cache)
    api.lifetime.signal.addEventListener('abort', () => ready.clear(), {
      once: true,
    })
  }
  return cache
}

export async function loadRemoteImage(
  src: string,
  queue: ImageQueue = 'chat',
): Promise<string> {
  if (!src.trim()) throw new Error('The image URL is required')
  const local = localImageSource(src)
  if (local) return local
  if (src.length > MAX_IMAGE_URL_LENGTH)
    throw new Error('The image URL is too long')
  const url = new URL(
    src,
    typeof window === 'undefined' ? undefined : window.location.href,
  )
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('The image URL is not allowed')
  url.hash = ''
  const key = url.href
  const api = harnessAPI()
  api.lifetime.signal.throwIfAborted()
  const cache = cacheFor(api)
  const ready = cache.ready.get(key)
  if (ready) return ready
  const pending = cache.pending[queue].get(key)
  if (pending) return pending
  const request = cache.limit[queue](async () => {
    api.lifetime.signal.throwIfAborted()
    const cached = cache.ready.get(key)
    if (cached) return cached
    const image = await api.post<RemoteImage>(
      ROUTES.remoteImage,
      { url: key },
      { keyless: true },
    )
    api.lifetime.signal.throwIfAborted()
    if (
      image.image_content_type !== PNG_TYPE ||
      typeof image.image_bytes !== 'string' ||
      image.image_bytes.length > MAX_ENCODED_IMAGE_LENGTH ||
      !BASE64.test(image.image_bytes)
    )
      throw new HarnessError(invalidResponse())
    const source = `data:${PNG_TYPE};base64,${image.image_bytes}`
    cache.ready.set(key, source)
    return source
  }).finally(() => cache.pending[queue].delete(key))
  cache.pending[queue].set(key, request)
  return request
}
