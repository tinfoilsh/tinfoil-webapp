import {
  loadRemoteImage,
  localImageSource,
} from '@/services/harness/remote-images'
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'

const IMAGE_PREFETCH_MARGIN = '256px'

interface PrivateImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  onUnavailable?: () => void
}

export function PrivateImage({
  src,
  onUnavailable,
  ...props
}: PrivateImageProps) {
  if (src instanceof Blob) {
    return <img {...props} src={src} srcSet={undefined} />
  }
  return (
    <ImageSource key={src} src={src} onUnavailable={onUnavailable} {...props} />
  )
}

type ImageSourceProps = Omit<PrivateImageProps, 'src'> & { src?: string }

function ImageSource({
  src,
  onUnavailable,
  alt = '',
  ...props
}: ImageSourceProps) {
  const local = localImageSource(src)
  const [source, setSource] = useState<string | undefined>(local)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)
  const shouldFetch =
    visible ||
    props.loading !== 'lazy' ||
    typeof IntersectionObserver === 'undefined'
  const placeholder = useRef<HTMLSpanElement>(null)
  const unavailable = useRef(onUnavailable)
  useEffect(() => {
    unavailable.current = onUnavailable
  })

  useEffect(() => {
    if (shouldFetch || local || !placeholder.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: IMAGE_PREFETCH_MARGIN },
    )
    observer.observe(placeholder.current)
    return () => observer.disconnect()
  }, [shouldFetch, local])

  useEffect(() => {
    if (local || !shouldFetch) return
    let canceled = false
    void loadRemoteImage(src ?? '').then(
      (resolved) => {
        if (!canceled) setSource(resolved)
      },
      () => {
        if (!canceled) {
          setFailed(true)
          unavailable.current?.()
        }
      },
    )
    return () => {
      canceled = true
    }
  }, [src, local, shouldFetch])

  if (!source)
    return (
      <span
        ref={placeholder}
        role="img"
        aria-label={alt || (failed ? 'Image unavailable' : 'Loading image')}
        aria-busy={!failed}
        className={props.className}
      >
        {failed ? alt || 'Image unavailable' : null}
      </span>
    )
  return <img {...props} src={source} srcSet={undefined} alt={alt} />
}
