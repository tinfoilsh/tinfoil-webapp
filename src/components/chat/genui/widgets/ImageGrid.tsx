import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  images: z
    .array(
      z.object({
        url: z.string(),
        alt: z.string().optional(),
        caption: z.string().optional(),
        link: z.string().optional(),
      }),
    )
    .min(1)
    .describe('One or more images to arrange in a grid'),
  title: z.string().optional(),
})

export const widget = defineGenUIWidget({
  name: 'render_image_grid',
  description:
    'Display multiple images arranged in a responsive grid. Use for galleries, comparisons, or when multiple visuals support a single topic.',
  schema,
  promptHint: 'multiple images as a responsive grid',
  render: ({ images, title }) => (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((img, i) => {
          const Wrapper = img.link ? 'a' : 'div'
          const wrapperProps = img.link
            ? {
                href: img.link,
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
  ),
})
