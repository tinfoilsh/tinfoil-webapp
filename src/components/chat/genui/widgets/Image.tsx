import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  url: z.string().describe('Image URL'),
  alt: z.string().optional().describe('Accessible alt text'),
  caption: z.string().optional(),
  link: z.string().optional().describe('Optional destination when clicked'),
  aspectRatio: z
    .enum(['square', 'video', 'auto'])
    .optional()
    .describe('Container shape: square (1:1), video (16:9), or auto'),
})

export const widget = defineGenUIWidget({
  name: 'render_image',
  description:
    'Display a single image with optional caption. Use for diagrams, logos, photos, or any single visual reference.',
  schema,
  promptHint: 'a single image with optional caption',
  render: ({ url, alt, caption, link, aspectRatio = 'auto' }) => {
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
          src={url}
          alt={alt ?? ''}
          wrapperClassName="relative h-full w-full overflow-hidden"
          className={`${aspectClass ? 'h-full w-full object-cover' : 'w-full'}`}
          loading="lazy"
        />
      </div>
    )
    return (
      <figure className="my-3 max-w-xl">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer">
            {content}
          </a>
        ) : (
          content
        )}
        {caption && (
          <figcaption className="mt-2 text-xs text-content-muted">
            {caption}
          </figcaption>
        )}
      </figure>
    )
  },
})
