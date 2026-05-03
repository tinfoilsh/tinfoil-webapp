import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { sanitizeUrl } from '@braintree/sanitize-url'
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

function SingleImage({
  image,
  aspectRatio = 'auto',
}: {
  image: ImageItem
  aspectRatio?: 'square' | 'video' | 'auto'
}) {
  const aspectClass =
    aspectRatio === 'square'
      ? 'aspect-square'
      : aspectRatio === 'video'
        ? 'aspect-video'
        : ''
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
  const safeLink = image.link ? sanitizeUrl(image.link) : null
  return (
    <figure className="my-3 max-w-xl">
      {safeLink ? (
        <a href={safeLink} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        content
      )}
      {image.caption && (
        <figcaption className="mt-2 text-xs text-content-muted">
          {image.caption}
        </figcaption>
      )}
    </figure>
  )
}

function ImageGrid({ images, title }: { images: ImageItem[]; title?: string }) {
  return (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((img, i) => {
          const safeLink = img.link ? sanitizeUrl(img.link) : null
          const Wrapper = safeLink ? 'a' : 'div'
          const wrapperProps = safeLink
            ? {
                href: safeLink,
                target: '_blank' as const,
                rel: 'noopener noreferrer',
              }
            : {}
          return (
            <Wrapper
              key={i}
              {...wrapperProps}
              className="group flex flex-col gap-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-card"
            >
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
            </Wrapper>
          )
        })}
      </div>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_image',
  description:
    'Display one or more images. Pass a single item for a large standalone image; pass multiple items to render a responsive grid (galleries, comparisons, multi-visual references).',
  schema,
  promptHint:
    'one or more images — pass a single item for a large standalone image, or multiple items for a responsive grid',
  render: ({ images, title, aspectRatio }: ImageWidgetArgs) => {
    if (images.length === 1) {
      return <SingleImage image={images[0]!} aspectRatio={aspectRatio} />
    }
    return <ImageGrid images={images} title={title} />
  },
})
