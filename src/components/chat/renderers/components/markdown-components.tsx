import { CONSTANTS } from '@/components/chat/constants'
import { CodeBlock } from '@/components/code-block'
import { Favicon } from '@/components/ui/favicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { sanitizeUrl } from '@braintree/sanitize-url'
import type { Components } from 'react-markdown'
import { ExpandableTable } from './ExpandableTable'

function getDomainName(url: string): string {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.replace(/^www\./, '')
    const parts = hostname.split('.')
    return parts.length > 1 ? parts[parts.length - 2] : hostname
  } catch {
    return ''
  }
}

function CitationPill({ url, title }: { url: string; title?: string }) {
  const sanitizedHref = sanitizeUrl(url)
  const domain = getDomainName(url)

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <a
          href={sanitizedHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mx-0.5 inline-flex h-[1.5em] items-center gap-1.5 whitespace-nowrap rounded-full bg-blue-500/10 pl-1 pr-2 align-middle text-[10px] font-medium leading-none text-blue-500 transition-colors hover:bg-blue-500/20"
        >
          <span
            className="inline-flex h-[1.1em] w-[1.1em] shrink-0 items-center justify-center rounded-full bg-white"
            aria-hidden="true"
          >
            <Favicon url={url} className="h-full w-full rounded-full p-[1px]" />
          </span>
          <span className="leading-none">{domain}</span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {title && <p className="text-sm font-medium leading-tight">{title}</p>}
        <a
          href={sanitizedHref}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-xs text-blue-500 hover:underline"
        >
          {url}
        </a>
      </TooltipContent>
    </Tooltip>
  )
}

interface CreateMarkdownComponentsOptions {
  isDarkMode: boolean
  isStreaming: boolean
  showMarkdownTablePlaceholder: boolean
  // URLs the router annotated as web-search citations, mapped to the source
  // title. Any markdown link whose href matches one of these URLs is rendered
  // as a citation pill to stay visually consistent with legacy chats that
  // stored citations as #cite-... anchors.
  citationUrlTitles?: Map<string, string>
}

export function createMarkdownComponents({
  isDarkMode,
  isStreaming,
  showMarkdownTablePlaceholder,
  citationUrlTitles,
}: CreateMarkdownComponentsOptions): Components {
  return {
    // Suppress hr elements
    hr: () => null,

    // Inline code and code blocks
    code({
      className,
      children,
      ...props
    }: {
      className?: string
      children?: React.ReactNode
      inline?: boolean
    } & React.HTMLAttributes<HTMLElement>) {
      if ((props as any).inline) {
        return (
          <code
            className={`${className || ''} bg-surface-secondary inline break-words rounded px-1.5 py-0.5 align-baseline font-mono text-sm text-content-primary`}
            {...props}
          >
            {children}
          </code>
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },

    // Code blocks
    pre({ children, ...props }: { children?: React.ReactNode }) {
      if (
        children &&
        typeof children === 'object' &&
        'props' in (children as any)
      ) {
        const codeProps = (children as any).props
        const className = codeProps?.className || ''
        const match = /language-([\w+#-]+)/.exec(className)
        const language = match ? match[1] : 'text'
        const code = String(codeProps?.children || '').replace(/\n$/, '')

        if (
          showMarkdownTablePlaceholder &&
          (language === 'markdown' || language === 'md')
        ) {
          return null
        }

        return (
          <CodeBlock
            code={code}
            language={language}
            isDarkMode={isDarkMode}
            isStreaming={isStreaming}
          />
        )
      }
      return <pre {...props}>{children}</pre>
    },

    // Table elements
    table({ children }: any) {
      return <ExpandableTable>{children}</ExpandableTable>
    },

    thead({ children, ...props }: any) {
      return (
        <thead {...props} className="bg-surface-secondary">
          {children}
        </thead>
      )
    },

    tbody({ children, ...props }: any) {
      return (
        <tbody
          {...props}
          className="bg-surface-primary divide-y divide-border-subtle"
        >
          {children}
        </tbody>
      )
    },

    tr({ children, ...props }: any) {
      return <tr {...props}>{children}</tr>
    },

    th({ children, ...props }: any) {
      return (
        <th
          {...props}
          className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-content-primary"
          style={{
            maxWidth: CONSTANTS.TABLE_COLUMN_MAX_WIDTH_PX,
            wordWrap: 'break-word',
            whiteSpace: 'normal',
          }}
        >
          {children}
        </th>
      )
    },

    td({ children, ...props }: any) {
      return (
        <td
          {...props}
          className="px-4 py-3 text-sm text-content-primary"
          style={{
            maxWidth: CONSTANTS.TABLE_COLUMN_MAX_WIDTH_PX,
            wordWrap: 'break-word',
            wordBreak: 'break-word',
            whiteSpace: 'normal',
          }}
        >
          {children}
        </td>
      )
    },

    // Block elements
    blockquote({ children, ...props }: any) {
      return (
        <blockquote
          {...props}
          className="my-4 border-l-4 border-border-subtle pl-4 text-content-primary"
        >
          {children}
        </blockquote>
      )
    },

    // Links with citation pill support
    a({ children, href, ...props }: any) {
      if (href?.startsWith('#cite-')) {
        const tildeIndex = href.indexOf('~')
        if (tildeIndex !== -1) {
          const rest = href.slice(tildeIndex + 1)
          const secondTildeIndex = rest.indexOf('~')
          if (secondTildeIndex !== -1) {
            // Legacy format retained so chats saved before the router started
            // emitting markdown citations keep rendering as pills.
            const url = rest.slice(0, secondTildeIndex)
            const title = decodeURIComponent(rest.slice(secondTildeIndex + 1))
            return <CitationPill url={url} title={title || undefined} />
          }
          return <CitationPill url={rest} />
        }
      }
      // Render as a citation pill when the markdown link points at a URL the
      // router annotated as a web-search source. Falls back to a regular
      // hyperlink for any other external link.
      if (href && citationUrlTitles?.has(href)) {
        const title = citationUrlTitles.get(href)
        return <CitationPill url={href} title={title || undefined} />
      }
      const sanitizedHref = sanitizeUrl(href)
      return (
        <a
          {...props}
          href={sanitizedHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline align-baseline text-blue-500 underline hover:text-blue-600"
        >
          {children}
        </a>
      )
    },

    // Text formatting
    strong({ children, ...props }: any) {
      return (
        <strong {...props} className="inline align-baseline font-semibold">
          {children}
        </strong>
      )
    },

    b({ children, ...props }: any) {
      return (
        <b {...props} className="inline align-baseline font-semibold">
          {children}
        </b>
      )
    },

    em({ children, ...props }: any) {
      return (
        <em {...props} className="inline align-baseline italic">
          {children}
        </em>
      )
    },

    i({ children, ...props }: any) {
      return (
        <i {...props} className="inline align-baseline italic">
          {children}
        </i>
      )
    },

    u({ children, ...props }: any) {
      return (
        <u {...props} className="inline align-baseline underline">
          {children}
        </u>
      )
    },

    s({ children, ...props }: any) {
      return (
        <s {...props} className="inline align-baseline line-through">
          {children}
        </s>
      )
    },

    del({ children, ...props }: any) {
      return (
        <del {...props} className="inline align-baseline line-through">
          {children}
        </del>
      )
    },

    mark({ children, ...props }: any) {
      return (
        <mark
          {...props}
          className="inline rounded bg-yellow-200 px-0.5 align-baseline text-content-primary dark:bg-yellow-800"
        >
          {children}
        </mark>
      )
    },

    // Superscript and subscript
    sup({ children, ...props }: any) {
      return (
        <sup {...props} className="align-super text-xs">
          {children}
        </sup>
      )
    },

    sub({ children, ...props }: any) {
      return (
        <sub {...props} className="align-sub text-xs">
          {children}
        </sub>
      )
    },

    // Line break
    br({ ...props }: any) {
      return <br {...props} />
    },

    // Generic container elements - pass through with text color
    div({ children, className, ...props }: any) {
      return (
        <div {...props} className={className || 'text-content-primary'}>
          {children}
        </div>
      )
    },

    span({ children, className, ...props }: any) {
      return (
        <span {...props} className={className || 'text-content-primary'}>
          {children}
        </span>
      )
    },

    p({ children, className, ...props }: any) {
      return (
        <p {...props} className={className || 'text-content-primary'}>
          {children}
        </p>
      )
    },

    // Lists
    ul({ children, ...props }: any) {
      return (
        <ul {...props} className="my-2 list-disc pl-6 text-content-primary">
          {children}
        </ul>
      )
    },

    ol({ children, ...props }: any) {
      return (
        <ol {...props} className="my-2 list-decimal pl-6 text-content-primary">
          {children}
        </ol>
      )
    },

    li({ children, ...props }: any) {
      return (
        <li {...props} className="my-1 text-content-primary">
          {children}
        </li>
      )
    },

    // Headings
    h1({ children, ...props }: any) {
      return (
        <h1 {...props} className="my-4 text-2xl font-bold text-content-primary">
          {children}
        </h1>
      )
    },

    h2({ children, ...props }: any) {
      return (
        <h2 {...props} className="my-3 text-xl font-bold text-content-primary">
          {children}
        </h2>
      )
    },

    h3({ children, ...props }: any) {
      return (
        <h3 {...props} className="my-2 text-lg font-bold text-content-primary">
          {children}
        </h3>
      )
    },

    h4({ children, ...props }: any) {
      return (
        <h4
          {...props}
          className="my-2 text-base font-bold text-content-primary"
        >
          {children}
        </h4>
      )
    },

    h5({ children, ...props }: any) {
      return (
        <h5 {...props} className="my-1 text-sm font-bold text-content-primary">
          {children}
        </h5>
      )
    },

    h6({ children, ...props }: any) {
      return (
        <h6 {...props} className="my-1 text-xs font-bold text-content-primary">
          {children}
        </h6>
      )
    },

    // Images
    img({ src, alt, ...props }: any) {
      return (
        <img
          {...props}
          src={src}
          alt={alt || ''}
          className="my-2 max-w-full rounded"
        />
      )
    },
  }
}
