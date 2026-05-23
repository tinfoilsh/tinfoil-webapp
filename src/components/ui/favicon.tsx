import { fetchLinkMetadata } from '@/services/inference/metadata-client'
import { useEffect, useState } from 'react'

// Module-level cache of resolved favicon data URLs keyed by page URL.
// Keeps remounts — for example, when react-markdown re-parses a
// streaming message and recreates citation pills — from flashing back
// through the loading placeholder once the icon has already been
// fetched.
const RESOLVED_FAVICON_DATA_URLS = new Map<string, string>()
const FAILED_FAVICONS = new Set<string>()

type FaviconState = 'loading' | 'ready' | 'error'

interface ResolvedFavicon {
  src: string
  state: FaviconState
}

function initialResolved(url: string): ResolvedFavicon {
  const existing = RESOLVED_FAVICON_DATA_URLS.get(url)
  if (existing) return { src: existing, state: 'ready' }
  if (FAILED_FAVICONS.has(url)) return { src: '', state: 'error' }
  return { src: '', state: 'loading' }
}

/**
 * Favicon <img> that loads the icon through the attested metadata
 * enclave. The bytes come back inlined in the `/metadata` response and
 * are rendered as a `data:` URL so the browser never reaches an
 * external icon host directly. Using a `data:` URL keeps the lifecycle
 * trivial: there's no Blob to allocate and no `URL.createObjectURL`
 * handle to revoke, so two concurrent components rendering the same
 * favicon can never invalidate each other's source.
 */
interface FaviconProps extends Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'onError' | 'onLoad'
> {
  /** Page URL; metadata is fetched against this. */
  url: string
  /** Rendered until the favicon bytes resolve. */
  placeholder?: React.ReactNode
  /** Rendered when no bytes are available. */
  fallback?: React.ReactNode
  /** Called once the image has fully loaded. */
  onResolve?: () => void
  /** Called when the image fails to load. */
  onResolveError?: () => void
}

export function Favicon({
  url,
  placeholder = null,
  fallback = null,
  onResolve,
  onResolveError,
  alt = '',
  className,
  ...imgProps
}: FaviconProps) {
  const [resolved, setResolved] = useState<ResolvedFavicon>(() =>
    initialResolved(url),
  )

  useEffect(() => {
    let cancelled = false
    setResolved(initialResolved(url))

    if (RESOLVED_FAVICON_DATA_URLS.has(url) || FAILED_FAVICONS.has(url)) {
      return () => {
        cancelled = true
      }
    }

    fetchLinkMetadata(url)
      .then((metadata) => {
        if (cancelled) return
        if (!metadata.faviconDataUrl) {
          FAILED_FAVICONS.add(url)
          setResolved({ src: '', state: 'error' })
          return
        }
        RESOLVED_FAVICON_DATA_URLS.set(url, metadata.faviconDataUrl)
        setResolved({ src: metadata.faviconDataUrl, state: 'ready' })
      })
      .catch(() => {
        if (cancelled) return
        FAILED_FAVICONS.add(url)
        setResolved({ src: '', state: 'error' })
      })

    return () => {
      cancelled = true
    }
  }, [url])

  if (resolved.state === 'error') return <>{fallback}</>
  if (resolved.state === 'loading') return <>{placeholder}</>

  return (
    <img
      {...imgProps}
      src={resolved.src}
      alt={alt}
      className={className}
      onLoad={() => {
        onResolve?.()
      }}
      onError={() => {
        FAILED_FAVICONS.add(url)
        setResolved({ src: '', state: 'error' })
        onResolveError?.()
      }}
    />
  )
}
