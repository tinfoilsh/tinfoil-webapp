import type { WebSearchSource } from '@/components/chat/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Favicon as EnclaveFavicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { ArrowUpRight } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

const MAX_PREVIEW_FAVICONS = 4

function getDomain(url: string): string {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Round favicon badge with a neutral fallback dot for sites that expose
 * no icon. Delegates the actual network fetch to the shared enclave-
 * backed `Favicon` component.
 */
function FaviconBadge({
  url,
  size,
  className,
}: {
  url: string
  size: number
  className?: string
}) {
  const fallback = (
    <span
      className={`bg-surface-secondary inline-flex items-center justify-center rounded-full text-content-muted ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="block rounded-full bg-current"
        style={{ width: size * 0.35, height: size * 0.35 }}
      />
    </span>
  )
  return (
    <EnclaveFavicon
      url={url}
      width={size}
      height={size}
      className={`shrink-0 rounded-full bg-white p-[1px] ${className ?? ''}`}
      placeholder={fallback}
      fallback={fallback}
    />
  )
}

interface SourcesButtonProps {
  sources: WebSearchSource[]
}

export const SourcesButton = memo(function SourcesButton({
  sources,
}: SourcesButtonProps) {
  const [isOpen, setIsOpen] = useState(false)

  const uniqueSources = useMemo(() => {
    const seen = new Set<string>()
    const unique: WebSearchSource[] = []
    for (const source of sources) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      unique.push(source)
    }
    return unique
  }, [sources])

  const previewDomains = useMemo(() => {
    const seen = new Set<string>()
    const domains: string[] = []
    for (const source of uniqueSources) {
      const domain = getDomain(source.url)
      if (seen.has(domain)) continue
      seen.add(domain)
      domains.push(source.url)
      if (domains.length >= MAX_PREVIEW_FAVICONS) break
    }
    return domains
  }, [uniqueSources])

  if (uniqueSources.length === 0) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 rounded-full border border-border-subtle px-3 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
        aria-label={`Show ${uniqueSources.length} source${uniqueSources.length === 1 ? '' : 's'}`}
      >
        <span>Sources</span>
        <span className="inline-flex items-center">
          {previewDomains.map((url, index) => (
            <FaviconBadge
              key={`${url}-${index}`}
              url={url}
              size={16}
              className={
                index === 0
                  ? 'border border-surface-chat'
                  : '-ml-1.5 border border-surface-chat'
              }
            />
          ))}
        </span>
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-hidden p-0">
          <DialogHeader className="border-b border-border-subtle px-6 py-4">
            <DialogTitle>Sources</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
            <ul className="flex flex-col">
              {uniqueSources.map((source, index) => (
                <li key={`${source.url}-${index}`}>
                  <a
                    href={sanitizeUrl(source.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-surface-chat-background"
                  >
                    <FaviconBadge
                      url={source.url}
                      size={20}
                      className="mt-0.5"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-content-primary">
                        {source.title || source.url}
                      </span>
                      <span className="truncate text-xs text-content-muted">
                        {getDomain(source.url)}
                      </span>
                    </div>
                    <ArrowUpRight
                      className="mt-1 h-3.5 w-3.5 shrink-0 text-content-muted opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
})
