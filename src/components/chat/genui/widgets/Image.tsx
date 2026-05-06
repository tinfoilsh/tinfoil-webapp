import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const imageSchema = z.object({
  url: z.string().describe('Image URL'),
  alt: z.string().optional().describe('Accessible alt text'),
  caption: z.string().optional(),
  link: z.string().optional().describe('Optional destination when clicked'),
})

const schema = z.object({
  images: z
    .array(imageSchema)
    .min(1)
    .describe(
      'One or more images. A single image renders large with an optional caption; multiple images render in a responsive grid.',
    ),
  title: z.string().optional(),
  aspectRatio: z
    .enum(['square', 'video', 'auto'])
    .optional()
    .describe(
      'Single-image only. Container shape: square (1:1), video (16:9), or auto. Ignored when multiple images are provided.',
    ),
})

type ImageWidgetArgs = z.infer<typeof schema>
type ImageItem = z.infer<typeof imageSchema>

interface LightboxState {
  open: boolean
  index: number
}

function ImageLightbox({
  images,
  state,
  onClose,
  onIndexChange,
}: {
  images: ImageItem[]
  state: LightboxState
  onClose: () => void
  onIndexChange: (index: number) => void
}) {
  const { open, index } = state

  const goPrev = useCallback(() => {
    if (images.length <= 1) return
    onIndexChange((index - 1 + images.length) % images.length)
  }, [images.length, index, onIndexChange])

  const goNext = useCallback(() => {
    if (images.length <= 1) return
    onIndexChange((index + 1) % images.length)
  }, [images.length, index, onIndexChange])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goPrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', handler)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handler)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose, goPrev, goNext])

  if (!open) return null
  const current = images[index]
  if (!current) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        aria-label="Close image preview"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
      >
        <X className="h-5 w-5" />
      </button>

      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              goPrev()
            }}
            aria-label="Previous image"
            className="absolute left-4 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              goNext()
            }}
            aria-label="Next image"
            className="absolute right-4 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      <figure
        className="flex max-h-full max-w-full flex-col items-center gap-3 px-12 pb-12 pt-12"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={current.url}
          alt={current.alt ?? ''}
          className="max-h-[80vh] max-w-full rounded-md object-contain"
          loading="eager"
          referrerPolicy="no-referrer"
        />
        {current.caption && (
          <figcaption className="text-center text-sm text-white/85">
            {current.caption}
          </figcaption>
        )}
        {images.length > 1 && (
          <p className="text-xs text-white/55">
            {index + 1} / {images.length}
          </p>
        )}
      </figure>
    </div>
  )
}

function SingleImage({
  image,
  images,
  aspectRatio = 'auto',
  onOpenPreview,
}: {
  image: ImageItem
  images: ImageItem[]
  aspectRatio?: 'square' | 'video' | 'auto'
  onOpenPreview: (index: number) => void
}) {
  const aspectClass =
    aspectRatio === 'square'
      ? 'aspect-square'
      : aspectRatio === 'video'
        ? 'aspect-video'
        : ''
  const safeLink = image.link ? sanitizeUrl(image.link) : null

  const content = (
    <div
      className={`relative w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-card ${aspectClass}`}
    >
      <ImageWithSkeleton
        src={image.url}
        alt={image.alt ?? ''}
        wrapperClassName="relative h-full w-full overflow-hidden"
        className={`${aspectClass ? 'h-full w-full object-cover' : 'w-full'}`}
        loading="lazy"
      />
    </div>
  )

  return (
    <figure className="my-3 max-w-xl">
      {safeLink ? (
        <a href={safeLink} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        <button
          type="button"
          onClick={() => onOpenPreview(images.indexOf(image))}
          className="block w-full cursor-zoom-in"
          aria-label="Open image preview"
        >
          {content}
        </button>
      )}
      {image.caption && (
        <figcaption className="mt-2 text-xs text-content-muted">
          {image.caption}
        </figcaption>
      )}
    </figure>
  )
}

function ImageGrid({
  images,
  title,
  onOpenPreview,
}: {
  images: ImageItem[]
  title?: string
  onOpenPreview: (index: number) => void
}) {
  return (
    <div className="my-3 w-full">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((img, i) => {
          const safeLink = img.link ? sanitizeUrl(img.link) : null
          const tile = (
            <>
              <div className="aspect-square w-full overflow-hidden bg-surface-chat-background">
                <ImageWithSkeleton
                  src={img.url}
                  alt={img.alt ?? ''}
                  wrapperClassName="relative h-full w-full overflow-hidden bg-surface-chat-background"
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
              </div>
              {img.caption && (
                <p className="line-clamp-2 px-2 pb-2 text-xs text-content-muted">
                  {img.caption}
                </p>
              )}
            </>
          )

          if (safeLink) {
            return (
              <a
                key={i}
                href={safeLink}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col gap-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-card"
              >
                {tile}
              </a>
            )
          }

          return (
            <button
              key={i}
              type="button"
              onClick={() => onOpenPreview(i)}
              aria-label="Open image preview"
              className="group flex cursor-zoom-in flex-col gap-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-card text-left"
            >
              {tile}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ImageGalleryRoot({ images, title, aspectRatio }: ImageWidgetArgs) {
  const [lightbox, setLightbox] = useState<LightboxState>({
    open: false,
    index: 0,
  })

  const openPreview = useCallback((index: number) => {
    setLightbox({ open: true, index: Math.max(0, index) })
  }, [])

  const closePreview = useCallback(() => {
    setLightbox((current) => ({ ...current, open: false }))
  }, [])

  const setIndex = useCallback((index: number) => {
    setLightbox((current) => ({ ...current, index }))
  }, [])

  const body =
    images.length === 1 ? (
      <SingleImage
        image={images[0]!}
        images={images}
        aspectRatio={aspectRatio}
        onOpenPreview={openPreview}
      />
    ) : (
      <ImageGrid images={images} title={title} onOpenPreview={openPreview} />
    )

  return (
    <>
      {body}
      <ImageLightbox
        images={images}
        state={lightbox}
        onClose={closePreview}
        onIndexChange={setIndex}
      />
    </>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_image',
  description:
    'Display one or more images. Pass a single item for a large standalone image; pass multiple items to render a responsive grid (galleries, comparisons, multi-visual references).',
  schema,
  promptHint:
    'one or more images — pass a single item for a large standalone image, or multiple items for a responsive grid',
  render: (args: ImageWidgetArgs) => <ImageGalleryRoot {...args} />,
})
