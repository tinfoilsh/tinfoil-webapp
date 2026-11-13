import { sanitizeUrl } from '@braintree/sanitize-url'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'
import { StreamingMarkdown } from './StreamingMarkdown'

const DEFAULT_REMARK_PLUGINS: PluggableList = [remarkGfm]
const DEFAULT_REHYPE_PLUGINS: PluggableList = []

// How the details of a step show markdown.
const STEP_COMPONENTS: Components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-1.5 break-words last:mb-0">{children}</p>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md border border-border-subtle bg-surface-chat p-2.5 font-mono text-[11px] text-content-primary">
      {children}
    </pre>
  ),
  code: ({
    inline,
    children,
  }: {
    inline?: boolean
    children?: React.ReactNode
  }) =>
    inline ? (
      <code className="inline break-words rounded border border-border-subtle bg-surface-chat px-1 py-0.5 align-baseline font-mono text-[11px] text-content-primary">
        {children}
      </code>
    ) : (
      <code className="block break-all font-mono text-[11px] text-content-primary">
        {children}
      </code>
    ),
  a: ({ children, href }: any) => {
    if (href?.startsWith('#cite-')) {
      const tildeIndex = href.indexOf('~')
      if (tildeIndex !== -1) {
        const rest = href.slice(tildeIndex + 1)
        const secondTildeIndex = rest.indexOf('~')
        if (secondTildeIndex !== -1) {
          const url = rest.slice(0, secondTildeIndex)
          let title: string
          try {
            title = decodeURIComponent(rest.slice(secondTildeIndex + 1))
          } catch {
            title = rest.slice(secondTildeIndex + 1)
          }
          const sanitizedHref = sanitizeUrl(url)
          return (
            <a
              href={sanitizedHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-0.5 inline-flex h-[1.5em] items-center gap-1 whitespace-nowrap rounded-full bg-blue-500/10 px-1.5 !align-baseline text-[10px] font-medium text-blue-500 transition-colors hover:bg-blue-500/20"
              title={title || url}
            >
              {children}
            </a>
          )
        }
        const sanitizedHref = sanitizeUrl(rest)
        return (
          <a
            href={sanitizedHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-0.5 inline-flex h-[1.5em] items-center gap-1 whitespace-nowrap rounded-full bg-blue-500/10 px-1.5 !align-baseline text-[10px] font-medium text-blue-500 transition-colors hover:bg-blue-500/20"
          >
            {children}
          </a>
        )
      }
    }
    if (!href) {
      return <span>{children}</span>
    }
    return (
      <a
        href={sanitizeUrl(href)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 underline hover:text-blue-600"
      >
        {children}
      </a>
    )
  },
}

// Markdown as the details of a step show it, as a reply's thoughts. Thoughts
// still streaming render in blocks, so each update parses only the last.
export function StepMarkdown({
  content,
  isStreaming = false,
  remarkPlugins = DEFAULT_REMARK_PLUGINS,
  rehypePlugins = DEFAULT_REHYPE_PLUGINS,
}: {
  content: string
  isStreaming?: boolean
  remarkPlugins?: PluggableList
  rehypePlugins?: PluggableList
}) {
  return (
    <StreamingMarkdown
      text={content}
      streaming={isStreaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={STEP_COMPONENTS}
    />
  )
}
