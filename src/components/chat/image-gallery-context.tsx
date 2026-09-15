'use client'

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
import Lightbox from 'yet-another-react-lightbox'
import 'yet-another-react-lightbox/styles.css'

import { getMessageImages } from './attachment-helpers'
import type { Attachment, Message } from './types'

export type GalleryImage = {
  key: string
  src: string
  alt: string
}

export function attachmentToImageSrc(attachment: Attachment): string | null {
  const data = attachment.base64 || attachment.thumbnailBase64
  if (!data) return null
  return `data:${attachment.mimeType || 'image/jpeg'};base64,${data}`
}

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
  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={images.map((image) => ({ src: image.src, alt: image.alt }))}
      controller={{ closeOnBackdropClick: true }}
      on={{ view: ({ index: nextIndex }) => onIndexChange(nextIndex) }}
    />
  )
}

type ImageGalleryContextValue = {
  openByKey: (key: string) => void
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
  const pending = useRef(new Set<string>())
  const urls = useRef(new Set<string>())
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const allocated = urls.current
    return () => {
      controller.abort()
      for (const url of allocated) URL.revokeObjectURL(url)
      allocated.clear()
    }
  }, [])
  const images = useMemo<
    (GalleryImage & { attachment: Attachment; cacheKey: string })[]
  >(() => {
    const collected: (GalleryImage & {
      attachment: Attachment
      cacheKey: string
    })[] = []
    messages.forEach((message, messageIndex) => {
      getMessageImages(message).forEach((attachment, imageIndex) => {
        const cacheKey = `${message.id ?? messageIndex}:${attachment.id}`
        const src = fullImages[cacheKey] ?? attachmentToImageSrc(attachment)
        if (!src) return
        collected.push({
          key: `${messageIndex}:${imageIndex}`,
          cacheKey,
          attachment,
          src,
          alt: attachment.fileName || 'Image',
        })
      })
    })
    return collected
  }, [messages, fullImages])

  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)

  const loadIndex = useCallback(
    (target: number) => {
      const image = images[target]
      if (
        !image ||
        !loadImage ||
        image.attachment.base64 ||
        fullImages[image.cacheKey] ||
        pending.current.has(image.cacheKey)
      )
        return
      pending.current.add(image.cacheKey)
      const signal = lifetime.current.signal
      void loadImage(image.attachment, signal)
        .then((blob) => {
          if (signal.aborted) return
          const url = URL.createObjectURL(blob)
          urls.current.add(url)
          setFullImages((previous) => ({ ...previous, [image.cacheKey]: url }))
        })
        .catch(() => {
          /* The thumbnail remains available if download fails. */
        })
        .finally(() => pending.current.delete(image.cacheKey))
    },
    [images, loadImage, fullImages],
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

  const value = useMemo(() => ({ openByKey }), [openByKey])

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
