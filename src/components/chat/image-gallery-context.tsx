'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
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
}: {
  messages: Message[]
  children: ReactNode
}) {
  const images = useMemo<GalleryImage[]>(() => {
    const collected: GalleryImage[] = []
    messages.forEach((message, messageIndex) => {
      getMessageImages(message).forEach((attachment, imageIndex) => {
        const src = attachmentToImageSrc(attachment)
        if (!src) return
        collected.push({
          key: `${messageIndex}:${imageIndex}`,
          src,
          alt: attachment.fileName || 'Image',
        })
      })
    })
    return collected
  }, [messages])

  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)

  const openByKey = useCallback(
    (key: string) => {
      const target = images.findIndex((image) => image.key === key)
      if (target === -1) return
      setIndex(target)
      setOpen(true)
    },
    [images],
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
        onIndexChange={setIndex}
      />
    </ImageGalleryContext.Provider>
  )
}
