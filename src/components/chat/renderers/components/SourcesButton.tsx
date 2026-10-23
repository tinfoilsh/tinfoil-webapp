import type { WebSearchSource } from '@/components/chat/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Favicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { TfExternalLink } from '@tinfoilsh/tinfoil-icons'
import { memo, useMemo, useState } from 'react'

const MAX_PREVIEW_FAVICONS = 4

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export const SourcesButton = memo(function SourcesButton({
  sources,
}: {
  sources: WebSearchSource[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const uniqueSources = useMemo(() => {
    const seen = new Set<string>()
    return sources.filter((source) => {
      if (seen.has(source.url)) return false
      seen.add(source.url)
      return true
    })
  }, [sources])
  const previews = useMemo(() => {
    const seen = new Set<string>()
    return uniqueSources
      .filter((source) => {
        const domain = getDomain(source.url)
        if (seen.has(domain)) return false
        seen.add(domain)
        return true
      })
      .slice(0, MAX_PREVIEW_FAVICONS)
  }, [uniqueSources])
  if (!uniqueSources.length) return null
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
          {previews.map((source, index) => (
            <Favicon
              key={source.url}
              url={source.url}
              width={16}
              height={16}
              className={`h-4 w-4 rounded-full border border-surface-chat bg-white ${index ? '-ml-1.5' : ''}`}
            />
          ))}
        </span>
      </button>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="max-h-[80vh] max-w-lg overflow-hidden p-0"
          aria-describedby={undefined}
        >
          <DialogHeader className="border-b border-border-subtle px-6 py-4">
            <DialogTitle>Sources</DialogTitle>
          </DialogHeader>
          <ul className="flex max-h-[60vh] flex-col overflow-y-auto p-2">
            {uniqueSources.map((source) => (
              <li key={source.url}>
                <a
                  href={sanitizeUrl(source.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-surface-chat-background"
                >
                  <Favicon
                    url={source.url}
                    width={20}
                    height={20}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-white"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-content-primary">
                      {source.title || source.url}
                    </span>
                    <span className="truncate text-xs text-content-muted">
                      {getDomain(source.url)}
                    </span>
                  </span>
                  <TfExternalLink
                    className="mt-1 h-3.5 w-3.5 shrink-0 text-content-muted opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
})
