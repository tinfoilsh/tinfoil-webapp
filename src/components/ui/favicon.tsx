import { fetchLinkMetadata } from '@/services/inference/metadata-client'
import { useEffect, useState } from 'react'

// Module-level cache of favicon object URLs keyed by page URL. Keeps
// remounts — for example, when react-markdown re-parses a streaming
// message and recreates citation pills — from flashing back through
// the loading placeholder before re-resolving an icon the browser has
// already decoded.
const RESOLVED_FAVICON_URLS = new Map<string, string>()
const FAILED_FAVICONS = new Set<string>()

type FaviconState = 'loading' | 'ready' | 'error'

interface ResolvedFavicon {
  src: string
  state: FaviconState
}

function initialResolved(url: string): ResolvedFavicon {
  if (FAILED_FAVICONS.has(url)) return { src: '', state: 'error' }
  const existing = RESOLVED_FAVICON_URLS.get(url)
  if (existing) return { src: existing, state: 'ready' }
  return { src: '', state: 'loading' }
}

/**
 * Favicon <img> that loads the icon through the attested metadata
 * enclave. The bytes are fetched as part of the standard `/metadata`
 * response, decoded into a Blob, and exposed as an object URL so the
 * browser never reaches an external icon host directly.
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

    if (FAILED_FAVICONS.has(url) || RESOLVED_FAVICON_URLS.has(url)) {
      return () => {
        cancelled = true
      }
    }

    fetchLinkMetadata(url)
      .then((metadata) => {
        if (cancelled) return
        if (!metadata.faviconBytes) {
          FAILED_FAVICONS.add(url)
          setResolved({ src: '', state: 'error' })
          return
        }
        // Reuse a cached object URL when one already exists for this
        // page. Two concurrent Favicon instances (for example a preview
        // and the dialog list) would otherwise each create a fresh
        // object URL and revoke the other's, leaving one of them
        // pointing at an invalid blob.
        let objectURL = RESOLVED_FAVICON_URLS.get(url)
        if (!objectURL) {
          const contentType = metadata.faviconContentType ?? 'image/x-icon'
          const blob = new Blob([metadata.faviconBytes], { type: contentType })
          objectURL = URL.createObjectURL(blob)
          RESOLVED_FAVICON_URLS.set(url, objectURL)
        }
        setResolved({ src: objectURL, state: 'ready' })
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
