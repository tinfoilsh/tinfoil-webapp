import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import {
  fetchLinkMetadata,
  type LinkMetadata,
} from '@/services/inference/metadata-client'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  url: z.string().describe('Full URL of the resource'),
  title: z.string().describe('Page or resource title'),
  description: z.string().optional(),
  image: z.string().optional().describe('Preview image URL'),
  siteName: z.string().optional(),
})

type Props = z.infer<typeof schema>

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Fetches OpenGraph metadata from the attested
 * `opengraph-metadata.tinfoil.sh` enclave and overwrites the
 * model-provided fields once the response arrives. Falls back silently to
 * the model's values if the fetch fails (e.g. attestation failure or a
 * non-public target URL).
 */
function useEnclaveMetadata(url: string): LinkMetadata | null {
  const [metadata, setMetadata] = useState<LinkMetadata | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchLinkMetadata(url)
      .then((m) => {
        if (!cancelled) setMetadata(m)
      })
      .catch(() => {
        /* keep model-provided values */
      })
    return () => {
      cancelled = true
    }
  }, [url])

  return metadata
}

function LinkPreview({ url, title, description, image, siteName }: Props) {
  const enclaveMetadata = useEnclaveMetadata(url)

  const resolvedTitle = enclaveMetadata?.title ?? title
  const resolvedDescription = enclaveMetadata?.description ?? description
  const resolvedImage = enclaveMetadata?.image ?? image
  const resolvedSiteName = enclaveMetadata?.siteName ?? siteName
  const resolvedFavicon = enclaveMetadata?.favicon
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
            {resolvedFavicon && (
              <ImageWithSkeleton
                src={resolvedFavicon}
                alt=""
                wrapperClassName="relative h-4 w-4 shrink-0 overflow-hidden rounded bg-surface-card"
                className="h-4 w-4 object-cover"
                loading="lazy"
              />
            )}
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
    'Display a rich preview card for a single web link. Use when linking to an article, page, or resource and you want to surface title, description, and favicon. The card fetches authoritative metadata (title, description, site name, image, favicon) from the attested opengraph-metadata.tinfoil.sh enclave; provide the best values you know as a fallback.',
  schema,
  promptHint: 'rich preview card for a single web link',
  render: (args) => <LinkPreview {...args} />,
})
