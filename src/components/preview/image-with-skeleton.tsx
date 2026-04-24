/**
 * Image with skeleton placeholder.
 *
 * Renders a shimmering placeholder while the underlying `<img>` is loading
 * and fades into the image once it reports `onLoad`. Falls back to a muted
 * placeholder tile on error.
 */
import { ImageOff } from 'lucide-react'
import { useState, type ImgHTMLAttributes } from 'react'

interface ImageWithSkeletonProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'onLoad' | 'onError'> {
  wrapperClassName?: string
  className?: string
}

export function ImageWithSkeleton({
  wrapperClassName,
  className,
  alt,
  ...imgProps
}: ImageWithSkeletonProps) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)

  return (
    <div
      className={
        wrapperClassName ??
        'relative h-full w-full overflow-hidden bg-surface-card'
      }
    >
      {!loaded && !errored && (
        <div className="absolute inset-0 animate-pulse bg-surface-card" />
      )}
      {errored ? (
        <div className="flex h-full w-full items-center justify-center bg-surface-card text-content-muted">
          <ImageOff className="h-6 w-6" />
        </div>
      ) : (
        <img
          {...imgProps}
          alt={alt ?? ''}
          className={`${className ?? ''} ${loaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      )}
    </div>
  )
}
