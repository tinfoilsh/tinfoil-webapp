import { fetchFavicon } from '@/services/inference/metadata-client'
import { useEffect, useState } from 'react'

/**
 * Favicon <img> that resolves its source via the attested
 * `opengraph-metadata.tinfoil.sh` enclave.
 *
 * Call sites previously pointed directly at `icons.duckduckgo.com/ip3/<host>.ico`,
 * which leaked every viewed link to a third party. This component swaps
 * that single-shot URL for an attested enclave round-trip that returns the
 * page's own `<link rel="icon">` (or falls back to `/favicon.ico`).
 *
 * Resolution state is per-hostname and deduplicated by `fetchFavicon`, so
 * a message with dozens of citations to the same domain pays for one
 * enclave request.
 */
interface FaviconProps
  extends Omit<
    React.ImgHTMLAttributes<HTMLImageElement>,
    'src' | 'onError' | 'onLoad'
  > {
  /** Page URL; only the hostname is used for the lookup. */
  url: string
  /** Rendered while the enclave round-trip is in flight. */
  placeholder?: React.ReactNode
  /** Rendered when the page exposes no favicon or the fetch fails. */
  fallback?: React.ReactNode
  /** Called once the image has fully loaded. */
  onResolve?: () => void
  /** Called when the resolved image fails to load. */
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
  const [src, setSrc] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'none'>(
    'loading',
  )

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setSrc(null)
    fetchFavicon(url)
      .then((resolved) => {
        if (cancelled) return
        if (resolved) {
          setSrc(resolved)
          setState('ready')
        } else {
          setState('none')
        }
      })
      .catch(() => {
        if (!cancelled) setState('none')
      })
    return () => {
      cancelled = true
    }
  }, [url])

  if (state === 'loading') return <>{placeholder}</>
  if (state === 'none' || state === 'error' || !src) return <>{fallback}</>

  return (
    <img
      {...imgProps}
      src={src}
      alt={alt}
      className={className}
      onLoad={() => onResolve?.()}
      onError={() => {
        setState('error')
        onResolveError?.()
      }}
    />
  )
}
