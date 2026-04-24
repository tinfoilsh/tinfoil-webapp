import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { Favicon } from '@/components/ui/favicon'
import { fetchLinkMetadata } from '@/services/inference/metadata-client'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  url: z.string().describe('Full URL of the resource'),
  title: z
    .string()
    .describe(
      'Best guess at the page or resource title. Used as a fallback if the metadata fetch fails.',
    ),
})

type Props = z.infer<typeof schema>

interface ResolvedMetadata {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Fetches OpenGraph metadata from the `opengraph-metadata.tinfoil.sh`
 * enclave. Falls back silently to the model-provided title if the fetch
 * fails — the metadata is a UX nicety, not a security claim, so a
 * failure just means we render a leaner card.
 */
function useEnclaveMetadata(url: string): ResolvedMetadata | null {
  const [metadata, setMetadata] = useState<ResolvedMetadata | null>(null)

  useEffect(() => {
    let cancelled = false
    setMetadata(null)
    fetchLinkMetadata(url)
      .then((data) => {
        if (cancelled) return
        setMetadata({
          title: data.title,
          description: data.description,
          image: data.image,
          siteName: data.siteName,
        })
      })
      .catch(() => {
        /* keep model-provided title; render a leaner card */
      })
    return () => {
      cancelled = true
    }
  }, [url])

  return metadata
}

function LinkPreview({ url, title }: Props) {
  const metadata = useEnclaveMetadata(url)

  const resolvedTitle = metadata?.title ?? title
  const resolvedDescription = metadata?.description
  const resolvedImage = metadata?.image
  const resolvedSiteName = metadata?.siteName
  const displayName = resolvedSiteName || getDomain(url)

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:border-border-primary my-3 flex w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-card transition-colors hover:bg-surface-chat-background"
    >
      {resolvedImage && (
        <ImageWithSkeleton
          src={resolvedImage}
          alt=""
          wrapperClassName="relative h-32 w-32 shrink-0 overflow-hidden bg-surface-card sm:h-40 sm:w-40"
          className="h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Favicon
              url={url}
              className="h-4 w-4 shrink-0 rounded object-cover"
            />
            <span className="truncate text-xs text-content-muted">
              {displayName}
            </span>
          </div>
          <p className="line-clamp-2 text-sm font-semibold text-content-primary">
            {resolvedTitle}
          </p>
          {resolvedDescription && (
            <p className="mt-1 line-clamp-2 text-xs text-content-muted">
              {resolvedDescription}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-content-muted">
          <span className="truncate">{getDomain(url)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </div>
      </div>
    </a>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_link_preview',
  description:
    'Display a rich preview card for a single web link. Use when linking to an article, page, or resource and you want to surface title, description, and favicon. The card fetches metadata (title, description, site name, image, favicon) from the opengraph-metadata.tinfoil.sh enclave. Provide only the URL and a fallback title — every other field is resolved server-side.',
  schema,
  promptHint: 'rich preview card for a single web link',
  render: (args) => <LinkPreview {...args} />,
})
