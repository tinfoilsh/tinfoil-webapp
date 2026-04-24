import { getFaviconUrl } from '@/services/inference/metadata-client'
import { useState } from 'react'

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
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

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
          setState('ready')
          onResolve?.()
        }}
        onError={() => {
          setState('error')
          onResolveError?.()
        }}
      />
    </>
  )
}
