import { getFaviconUrl } from '@/services/inference/metadata-client'
import { useState } from 'react'

// Module-level memory of favicon URLs that have already loaded (or failed)
// during this session. Keeps remounts — for example, when react-markdown
// re-parses a streaming message and recreates citation pills — from
// flashing back through the loading placeholder before re-resolving an
// image the browser already has cached.
const RESOLVED_FAVICONS = new Set<string>()
const FAILED_FAVICONS = new Set<string>()

type FaviconState = 'loading' | 'ready' | 'error'

function initialFaviconState(src: string | null): FaviconState {
  if (!src) return 'error'
  if (FAILED_FAVICONS.has(src)) return 'error'
  if (RESOLVED_FAVICONS.has(src)) return 'ready'
  return 'loading'
}

/**
 * Favicon <img> that loads the icon through the enclave's `/favicon`
 * endpoint. Call sites previously pointed directly at
 * `icons.duckduckgo.com/ip3/<host>.ico`, which leaked every viewed link
 * to a third party. This component targets the enclave instead; the
 * enclave proxies to DuckDuckGo server-side and streams back bytes.
 *
 * Rendered state is local (load/error) because the browser fetches the
 * image directly — there is no JSON round-trip to manage.
 */
interface FaviconProps
  extends Omit<
    React.ImgHTMLAttributes<HTMLImageElement>,
    'src' | 'onError' | 'onLoad'
  > {
  /** Page URL; only the hostname is used for the lookup. */
  url: string
  /** Rendered until the enclave response starts decoding. */
  placeholder?: React.ReactNode
  /** Rendered when the image fails to load. */
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
  const src = getFaviconUrl(url)
  const [state, setState] = useState<FaviconState>(() =>
    initialFaviconState(src),
  )

  if (!src) return <>{fallback}</>
  if (state === 'error') return <>{fallback}</>

  return (
    <>
      {state === 'loading' && placeholder}
      <img
        {...imgProps}
        src={src}
        alt={alt}
        className={className}
        style={
          state === 'loading'
            ? { display: 'none', ...imgProps.style }
            : imgProps.style
        }
        onLoad={() => {
          RESOLVED_FAVICONS.add(src)
          setState('ready')
          onResolve?.()
        }}
        onError={() => {
          FAILED_FAVICONS.add(src)
          setState('error')
          onResolveError?.()
        }}
      />
    </>
  )
}
