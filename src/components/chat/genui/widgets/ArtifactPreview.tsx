/**
 * ArtifactPreview widget.
 *
 * Renders a compact inline summary card in the chat. Clicking "Open preview"
 * dispatches `OPEN_ARTIFACT_PREVIEW_EVENT` on `window` with an
 * `ArtifactPreviewSidebarDetail`. `chat-interface.tsx` listens for the event
 * and shows the full artifact in a right-side slide-over via
 * `ArtifactPreviewPanel`.
 *
 * Supported source types: `url`, `html`, `markdown`, `svg`, `mermaid`.
 */
import CopyButton from '@/components/copy-button'
import { MermaidPreview } from '@/components/preview/mermaid-preview'
import { SvgPreview } from '@/components/preview/svg-preview'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/components/ui/utils'
import { Code2, Download, ExternalLink, Eye, FileText } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

export const OPEN_ARTIFACT_PREVIEW_EVENT = 'openArtifactPreviewSidebar'

const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    url: z.string().describe('Absolute URL rendered inside a sandboxed iframe'),
  }),
  z.object({
    type: z.literal('html'),
    html: z.string().describe('Raw HTML markup rendered in a sandboxed iframe'),
  }),
  z.object({
    type: z.literal('markdown'),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal('svg'),
    svg: z
      .string()
      .describe('Raw SVG markup — will be sanitized before render'),
  }),
  z.object({
    type: z.literal('mermaid'),
    code: z.string().describe('Mermaid diagram source'),
  }),
])

export type ArtifactSource = z.infer<typeof sourceSchema>

const schema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  source: sourceSchema.describe(
    'The artifact payload. Pick the `type` that matches your content: ' +
      '`url` for a live site, `html` for a self-contained page, `markdown` ' +
      'for rich text, `svg` for vector art, `mermaid` for diagrams.',
  ),
  footer: z.string().optional().describe('Optional small footnote text'),
})

export interface ArtifactPreviewSidebarDetail {
  title?: string
  description?: string
  source: ArtifactSource
  footer?: string
}

export function openArtifactPreviewSidebar(
  detail: ArtifactPreviewSidebarDetail,
): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ArtifactPreviewSidebarDetail>(OPEN_ARTIFACT_PREVIEW_EVENT, {
      detail,
    }),
  )
}

/**
 * Structural equality check used by the sidebar listener to decide whether
 * an incoming `OPEN_ARTIFACT_PREVIEW_EVENT` is for the artifact that is
 * already showing (in which case the sidebar toggles closed).
 */
export function artifactDetailsEqual(
  a: ArtifactPreviewSidebarDetail,
  b: ArtifactPreviewSidebarDetail,
): boolean {
  if (a.title !== b.title) return false
  if (a.description !== b.description) return false
  if (a.footer !== b.footer) return false
  if (a.source.type !== b.source.type) return false
  return sourceToCopyString(a.source) === sourceToCopyString(b.source)
}

function getSourceLabel(source: ArtifactSource): string {
  switch (source.type) {
    case 'url':
      return 'Hosted preview'
    case 'html':
      return 'HTML artifact'
    case 'markdown':
      return 'Markdown artifact'
    case 'svg':
      return 'SVG artifact'
    case 'mermaid':
      return 'Diagram artifact'
  }
}

function sourceToCopyString(source: ArtifactSource): string {
  switch (source.type) {
    case 'url':
      return source.url
    case 'html':
      return source.html
    case 'markdown':
      return source.markdown
    case 'svg':
      return source.svg
    case 'mermaid':
      return source.code
  }
}

function sourceToDownload(
  source: ArtifactSource,
  title: string | undefined,
): { content: string; mimeType: string; filename: string } {
  const base =
    (title ?? 'artifact').trim().replace(/[^\w.-]+/g, '-') || 'artifact'
  switch (source.type) {
    case 'url':
      return {
        content: source.url,
        mimeType: 'text/plain;charset=utf-8',
        filename: `${base}.url.txt`,
      }
    case 'html':
      return {
        content: source.html,
        mimeType: 'text/html;charset=utf-8',
        filename: `${base}.html`,
      }
    case 'markdown':
      return {
        content: source.markdown,
        mimeType: 'text/markdown;charset=utf-8',
        filename: `${base}.md`,
      }
    case 'svg':
      return {
        content: source.svg,
        mimeType: 'image/svg+xml',
        filename: `${base}.svg`,
      }
    case 'mermaid':
      return {
        content: source.code,
        mimeType: 'text/plain;charset=utf-8',
        filename: `${base}.mmd`,
      }
  }
}

function downloadArtifact(
  source: ArtifactSource,
  title: string | undefined,
): void {
  if (typeof window === 'undefined') return
  const { content, mimeType, filename } = sourceToDownload(source, title)
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type ViewMode = 'preview' | 'source'
type ArtifactPreviewPanelLayout = 'card' | 'sidebar'

function Preview({
  source,
  title,
  isDarkMode,
  className,
}: {
  source: ArtifactSource
  title?: string
  isDarkMode: boolean
  className?: string
}) {
  switch (source.type) {
    case 'url':
      return (
        <iframe
          title={title ?? 'Artifact preview'}
          src={source.url}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          className={
            className ?? 'h-[420px] w-full rounded-md border-0 bg-white'
          }
        />
      )
    case 'html':
      return (
        <iframe
          title={title ?? 'Artifact preview'}
          srcDoc={source.html}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          className={
            className ?? 'h-[420px] w-full rounded-md border-0 bg-white'
          }
        />
      )
    case 'markdown':
      return (
        <div
          className={
            className ??
            'prose prose-sm max-w-none text-content-primary dark:prose-invert'
          }
        >
          <ReactMarkdown>{source.markdown}</ReactMarkdown>
        </div>
      )
    case 'svg':
      return <SvgPreview code={source.svg} className={className} />
    case 'mermaid':
      return (
        <MermaidPreview
          code={source.code}
          isDarkMode={isDarkMode}
          className={className}
        />
      )
  }
}

function getSidebarPreviewClassName(source: ArtifactSource): string {
  switch (source.type) {
    case 'url':
    case 'html':
      return 'h-full w-full border-0 bg-white'
    case 'markdown':
      return 'prose prose-sm h-full max-w-none overflow-auto px-4 py-3 text-content-primary dark:prose-invert'
    case 'svg':
    case 'mermaid':
      return 'flex h-full w-full items-center justify-center overflow-auto p-4 [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:w-full [&>svg]:max-w-full'
  }
}

interface ArtifactPreviewPanelProps extends ArtifactPreviewSidebarDetail {
  isDarkMode?: boolean
  className?: string
  layout?: ArtifactPreviewPanelLayout
}

/**
 * Full artifact panel. Shared between the sidebar body (`layout="sidebar"`)
 * and any future inline full-height embedding (`layout="card"`).
 */
export function ArtifactPreviewPanel({
  title,
  description,
  source,
  footer,
  isDarkMode = true,
  className,
  layout = 'card',
}: ArtifactPreviewPanelProps) {
  const [mode, setMode] = useState<ViewMode>('preview')
  const isSidebarLayout = layout === 'sidebar'
  const copyText = sourceToCopyString(source)

  return (
    <Card
      className={cn(
        'overflow-hidden',
        isSidebarLayout
          ? 'flex h-full min-h-0 flex-col rounded-none border-0 shadow-none'
          : 'my-3',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-surface-chat-background px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
            {getSourceLabel(source)}
          </p>
          {title && <CardTitle className="mt-1 text-base">{title}</CardTitle>}
          {description && (
            <CardDescription className="mt-1">{description}</CardDescription>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode(mode === 'preview' ? 'source' : 'preview')}
            className="flex h-6 items-center gap-1 rounded px-2 text-xs text-content-muted hover:bg-surface-card hover:text-content-primary"
          >
            {mode === 'preview' ? (
              <>
                <Code2 className="h-3.5 w-3.5" />
                <span>Source</span>
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" />
                <span>Preview</span>
              </>
            )}
          </button>
          {source.type === 'url' && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-6 items-center gap-1 rounded px-2 text-xs text-content-muted hover:bg-surface-card hover:text-content-primary"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Open</span>
            </a>
          )}
          <CopyButton text={copyText} />
        </div>
      </div>
      <CardContent
        className={cn(isSidebarLayout ? 'flex min-h-0 flex-1 p-0' : 'p-4')}
      >
        {mode === 'preview' ? (
          <Preview
            source={source}
            title={title}
            isDarkMode={isDarkMode}
            className={
              isSidebarLayout ? getSidebarPreviewClassName(source) : undefined
            }
          />
        ) : (
          <pre
            className={cn(
              'overflow-auto bg-surface-chat-background text-xs text-content-primary',
              isSidebarLayout
                ? 'h-full flex-1 rounded-none p-4'
                : 'max-h-[420px] rounded-md p-3',
            )}
          >
            <code>{copyText}</code>
          </pre>
        )}
      </CardContent>
      {footer && (
        <CardFooter className="border-t border-border-subtle bg-surface-chat-background px-4 py-3">
          <p className="text-xs text-content-muted">{footer}</p>
        </CardFooter>
      )}
    </Card>
  )
}

/**
 * Full-width inline card shown in the chat scroll. The row itself is a
 * single click target that toggles the artifact sidebar. The download
 * button lives inside the row but stops propagation so the sidebar
 * doesn't toggle when the user just wants to save the file.
 */
function ArtifactPreviewInlineCard({
  title,
  description,
  source,
  footer,
}: z.infer<typeof schema>) {
  const detail: ArtifactPreviewSidebarDetail = {
    title,
    description,
    source,
    footer,
  }
  const displayTitle = title ?? getSourceLabel(source)
  const subtitle = description ?? getSourceLabel(source)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openArtifactPreviewSidebar(detail)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openArtifactPreviewSidebar(detail)
        }
      }}
      className="my-3 flex w-full cursor-pointer items-center gap-4 rounded-lg border border-border-subtle bg-surface-card px-4 py-4 text-left transition-colors hover:bg-surface-chat-background"
    >
      <FileText
        className="h-6 w-6 flex-shrink-0 text-content-muted"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-content-primary">
          {displayTitle}
        </span>
        <span className="truncate text-xs text-content-muted">{subtitle}</span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          downloadArtifact(source, title)
        }}
        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-card"
        aria-label="Download artifact"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_artifact_preview',
  description:
    'Display a visual artifact in a side panel: a hosted URL, a self-contained HTML snippet, Markdown, an SVG illustration, or a Mermaid diagram. Use for content worth inspecting at full size — diagrams, interactive demos, long-form documents, charts you authored as SVG, or rich HTML mockups. The chat shows a compact summary card; clicking it opens the full artifact in the right sidebar.',
  schema,
  promptHint:
    'large artifacts (mermaid/svg/markdown/html/url) opened in a side panel',
  render: (args) => <ArtifactPreviewInlineCard {...args} />,
})
