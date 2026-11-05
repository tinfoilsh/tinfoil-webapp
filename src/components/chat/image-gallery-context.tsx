'use client'

import { logError } from '@/utils/error-handling'
import { TfBoxX, TfImageSlash } from '@tinfoilsh/tinfoil-icons'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PiSpinner } from 'react-icons/pi'
import Lightbox, { type Slide } from 'yet-another-react-lightbox'
import 'yet-another-react-lightbox/styles.css'

import type { Attachment, Message } from './types'

// At most this many full images load at once, so a long chat of images
// without thumbnails asks for them a few at a time.
export const MAX_CONCURRENT_IMAGE_LOADS = 3

export type GalleryImage = {
  key: string
  // Absent until an image without a thumbnail loads its full copy.
  src?: string
  alt: string
  // The image has no source and none will load.
  failed?: boolean
}

export function attachmentToImageSrc(attachment: Attachment): string | null {
  const data = attachment.base64 || attachment.thumbnailBase64
  if (!data) return null
  return `data:${attachment.mimeType || 'image/jpeg'};base64,${data}`
}

const loadingIcon = () => (
  <span className="yarl__slide_loading">
    <PiSpinner
      className="yarl__icon animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    />
  </span>
)

const errorIcon = () => (
  <TfImageSlash className="yarl__icon yarl__slide_error" aria-hidden="true" />
)

/**
 * Thin wrapper around the lightbox library so the provider and any local
 * fallbacks share one configuration (and a single stylesheet import).
 */
export function ImageLightbox({
  images,
  index,
  open,
  onClose,
  onIndexChange,
}: {
  images: GalleryImage[]
  index: number
  open: boolean
  onClose: () => void
  onIndexChange: (index: number) => void
}) {
  const slides: Slide[] = images.map((image) => ({
    src: image.src ?? '',
    alt: image.alt,
  }))
  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides}
      render={{
        // An image without a source yet shows that it loads, or failed to.
        slide: ({ slide }) => {
          const image = images[slides.indexOf(slide)]
          if (!image || image.src) return undefined
          return (
            <div className="yarl__slide_placeholder">
              {image.failed ? errorIcon() : loadingIcon()}
            </div>
          )
        },
        iconClose: () => <TfBoxX className="yarl__icon" aria-hidden="true" />,
        iconError: errorIcon,
        iconLoading: loadingIcon,
      }}
      controller={{ closeOnBackdropClick: true }}
      on={{ view: ({ index: nextIndex }) => onIndexChange(nextIndex) }}
    />
  )
}

type CollectedImage = GalleryImage & {
  attachment: Attachment
  cacheKey: string
}

// The full images a gallery loads, by cache key: those waiting, the next
// first; those asked for, which stay asked for once loaded; those that
// failed to load; and how many load now. Unmounting the gallery aborts them.
type ImageLoads = {
  controller: AbortController
  waiting: CollectedImage[]
  requested: Set<string>
  failed: Set<string>
  loading: number
}

type ImageGalleryContextValue = {
  openByKey: (key: string) => void
  // The image under a key, whose full copy the chat shows in place of a
  // missing thumbnail once it loads.
  imageByKey: (key: string) => GalleryImage | undefined
  // Loads the full copy of an image the chat shows without a thumbnail. A
  // failed one is tried again only when the gallery opens it.
  show: (key: string) => void
}

const ImageGalleryContext = createContext<ImageGalleryContextValue | null>(null)

export function useImageGallery() {
  return useContext(ImageGalleryContext)
}

/**
 * Collects every image across the conversation so a click on any in-chat
 * thumbnail opens a single gallery the user can page through end to end.
 * Image keys are `${messageIndex}:${imageIndex}` because legacy attachment
 * ids are only unique within a message, not across the whole conversation.
 */
export function ImageGalleryProvider({
  messages,
  children,
  loadImage,
}: {
  loadImage?: (attachment: Attachment, signal: AbortSignal) => Promise<Blob>
  messages: Message[]
  children: ReactNode
}) {
  const [fullImages, setFullImages] = useState<Record<string, string>>({})
  const [failedImages, setFailedImages] = useState<Record<string, true>>({})
  const urls = useRef(new Set<string>())
  const loads = useRef<ImageLoads | null>(null)
  useEffect(() => {
    const allocated = urls.current
    return () => {
      loads.current?.controller.abort()
      loads.current = null
      for (const url of allocated) URL.revokeObjectURL(url)
      allocated.clear()
    }
  }, [])
  const canLoad = !!loadImage
  const images = useMemo<CollectedImage[]>(() => {
    const collected: CollectedImage[] = []
    messages.forEach((message, messageIndex) => {
      message.attachments
        ?.filter((attachment) => attachment.type === 'image')
        .forEach((attachment, imageIndex) => {
          const cacheKey = `${message.id ?? messageIndex}:${attachment.id}`
          const src =
            fullImages[cacheKey] ??
            attachmentToImageSrc(attachment) ??
            undefined
          collected.push({
            key: `${messageIndex}:${imageIndex}`,
            cacheKey,
            attachment,
            src,
            alt: attachment.fileName || 'Image',
            failed: !src && (!canLoad || !!failedImages[cacheKey]),
          })
        })
    })
    return collected
  }, [messages, fullImages, failedImages, canLoad])

  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)

  // Loads an image's full copy after those waiting, or, as the gallery
  // opens it, before them and again if it failed.
  const request = useCallback(
    (image: CollectedImage, opened: boolean) => {
      if (!loadImage || image.attachment.base64) return
      const current = (loads.current ??= {
        controller: new AbortController(),
        waiting: [],
        requested: new Set(),
        failed: new Set(),
        loading: 0,
      })
      const { signal } = current.controller
      const load = async ({ attachment, cacheKey }: CollectedImage) => {
        current.loading++
        try {
          const blob = await loadImage(attachment, signal)
          if (signal.aborted) return
          const url = URL.createObjectURL(blob)
          urls.current.add(url)
          setFullImages((previous) => ({ ...previous, [cacheKey]: url }))
        } catch (error) {
          if (signal.aborted) return
          logError('Failed to load image', error, {
            component: 'ImageGalleryProvider',
            action: 'loadImage',
          })
          current.requested.delete(cacheKey)
          current.failed.add(cacheKey)
          setFailedImages((previous) => ({ ...previous, [cacheKey]: true }))
        } finally {
          current.loading--
          pump()
        }
      }
      const pump = () => {
        while (
          !signal.aborted &&
          current.loading < MAX_CONCURRENT_IMAGE_LOADS &&
          current.waiting.length
        )
          void load(current.waiting.shift()!)
      }
      const { cacheKey } = image
      const waitingAt = current.waiting.findIndex(
        (other) => other.cacheKey === cacheKey,
      )
      if (waitingAt !== -1) {
        if (!opened) return
        current.waiting.splice(waitingAt, 1)
      } else if (current.requested.has(cacheKey)) return
      else if (current.failed.has(cacheKey)) {
        if (!opened) return
        current.failed.delete(cacheKey)
        setFailedImages(({ [cacheKey]: _retried, ...rest }) => rest)
      }
      current.requested.add(cacheKey)
      if (opened) current.waiting.unshift(image)
      else current.waiting.push(image)
      pump()
    },
    [loadImage],
  )
  const loadIndex = useCallback(
    (target: number) => {
      const image = images[target]
      if (image) request(image, true)
    },
    [images, request],
  )
  const imageByKey = useCallback(
    (key: string) => images.find((image) => image.key === key),
    [images],
  )
  const show = useCallback(
    (key: string) => {
      const image = imageByKey(key)
      if (image) request(image, false)
    },
    [imageByKey, request],
  )
  const openByKey = useCallback(
    (key: string) => {
      const target = images.findIndex((image) => image.key === key)
      if (target === -1) return
      setIndex(target)
      setOpen(true)
      loadIndex(target)
    },
    [images, loadIndex],
  )

  const value = useMemo(
    () => ({ openByKey, imageByKey, show }),
    [openByKey, imageByKey, show],
  )

  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
      <ImageLightbox
        images={images}
        index={index}
        open={open}
        onClose={() => setOpen(false)}
        onIndexChange={(next) => {
          setIndex(next)
          loadIndex(next)
        }}
      />
    </ImageGalleryContext.Provider>
  )
}
