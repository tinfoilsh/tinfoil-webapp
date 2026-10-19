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
import { CONSTANTS } from '@/components/chat/constants'
import CopyButton from '@/components/copy-button'
import {
  SandboxUnavailable,
  useSandboxRunner,
  type SandboxRun,
} from '@/components/preview/sandbox-frame'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/components/ui/utils'
import { sanitizeUrl } from '@braintree/sanitize-url'
import {
  TfCode2,
  TfDownload,
  TfExternalLink,
  TfEye,
  TfPlay,
  type IconType,
} from '@tinfoilsh/tinfoil-icons'
import { FileText } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

export const OPEN_ARTIFACT_PREVIEW_EVENT = 'openArtifactPreviewSidebar'

const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    url: z.string(),
  }),
  z.object({
    type: z.literal('html'),
    html: z.string(),
  }),
  z.object({
    type: z.literal('markdown'),
    markdown: z.string(),
  }),
])

export type ArtifactSource = z.infer<typeof sourceSchema>

const schema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  source: sourceSchema,
  footer: z.string().optional(),
})

export interface ArtifactPreviewSidebarDetail {
  title?: string
  description?: string
  source: ArtifactSource
  footer?: string
}

export interface ArtifactPreviewSidebarEventDetail {
  artifact: ArtifactPreviewSidebarDetail
  action: 'open' | 'toggle'
  toolCallId?: string
}

export function openArtifactPreviewSidebar(
  detail: ArtifactPreviewSidebarDetail,
  action: ArtifactPreviewSidebarEventDetail['action'] = 'toggle',
  toolCallId?: string,
): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ArtifactPreviewSidebarEventDetail>(
      OPEN_ARTIFACT_PREVIEW_EVENT,
      {
        detail: { artifact: detail, action, toolCallId },
      },
    ),
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

export function artifactPreviewTargetsEqual(
  currentArtifact: ArtifactPreviewSidebarDetail,
  currentToolCallId: string | null,
  incomingArtifact: ArtifactPreviewSidebarDetail,
  incomingToolCallId?: string,
): boolean {
  if (currentToolCallId && incomingToolCallId) {
    return (
      currentToolCallId === incomingToolCallId &&
      artifactDetailsEqual(currentArtifact, incomingArtifact)
    )
  }
  return artifactDetailsEqual(currentArtifact, incomingArtifact)
}

/**
 * Restrict URL artifacts to HTTPS so a model-supplied `http://` link can't
 * downgrade an otherwise-secure preview pane (mixed content would also be
 * blocked by the browser, but failing fast in code is cleaner than relying
 * on that behavior). `sanitizeUrl` already strips `javascript:` and other
 * dangerous schemes; this layer adds the transport requirement.
 */
function safeArtifactUrl(rawUrl: string): string {
  const sanitized = sanitizeUrl(rawUrl)
  try {
    const parsed = new URL(sanitized)
    if (parsed.protocol === 'https:') return sanitized
  } catch {
    // Not parseable — fall through to about:blank
  }
  return 'about:blank'
}

function getSourceLabel(source: ArtifactSource): string {
  switch (source.type) {
    case 'url':
      return 'Hosted preview'
    case 'html':
      return 'HTML artifact'
    case 'markdown':
      return 'Markdown artifact'
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

function FocusableIframe({
  title,
  src,
  run = null,
  className,
  shouldAutoFocus,
}: {
  title: string
  src: string
  /** When set, the frame is the sandbox runner and receives this run. */
  run?: SandboxRun | null
  className: string
  shouldAutoFocus: boolean
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sandbox = useSandboxRunner(iframeRef, run)

  const focusIframe = useCallback(() => {
    iframeRef.current?.contentWindow?.focus()
  }, [])

  useEffect(() => {
    if (!shouldAutoFocus) return
    focusIframe()
  }, [focusIframe, shouldAutoFocus, src, run])

  if (run && sandbox.failed) return <SandboxUnavailable />

  return (
    <iframe
      ref={iframeRef}
      title={title}
      src={run ? sandbox.src : src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className}
      onLoad={shouldAutoFocus ? focusIframe : undefined}
      onMouseEnter={shouldAutoFocus ? focusIframe : undefined}
    />
  )
}

function HtmlArtifactFrame({
  title,
  html,
  className,
  shouldAutoFocus,
}: {
  title: string
  html: string
  className: string
  shouldAutoFocus: boolean
}) {
  const instanceId = useId()
  const run = useMemo<SandboxRun>(
    () => ({ type: 'tinfoil-sandbox-run', kind: 'artifact', instanceId, html }),
    [html, instanceId],
  )
  return (
    <FocusableIframe
      title={title}
      src=""
      run={run}
      className={className}
      shouldAutoFocus={shouldAutoFocus}
    />
  )
}

function Preview({
  source,
  title,
  className,
  shouldAutoFocusIframe = false,
}: {
  source: ArtifactSource
  title?: string
  className?: string
  shouldAutoFocusIframe?: boolean
}) {
  switch (source.type) {
    case 'url':
      return (
        <FocusableIframe
          title={title ?? 'Artifact preview'}
          src={safeArtifactUrl(source.url)}
          className={
            className ?? 'h-[420px] w-full rounded-md border-0 bg-white'
          }
          shouldAutoFocus={shouldAutoFocusIframe}
        />
      )
    case 'html':
      // Model-authored HTML runs on the unverified sandbox origin.
      return (
        <HtmlArtifactFrame
          title={title ?? 'Artifact preview'}
          html={source.html}
          className={
            className ?? 'h-[420px] w-full rounded-md border-0 bg-white'
          }
          shouldAutoFocus={shouldAutoFocusIframe}
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
  }
}

function getSidebarPreviewClassName(source: ArtifactSource): string {
  switch (source.type) {
    case 'url':
    case 'html':
      return 'h-full w-full border-0 bg-white'
    case 'markdown':
      return 'prose prose-sm h-full max-w-none overflow-auto px-4 py-3 text-content-primary dark:prose-invert'
  }
}

const VIEW_TABS: { mode: ViewMode; label: string; icon: IconType }[] = [
  { mode: 'preview', label: 'Preview', icon: TfEye },
  { mode: 'source', label: 'Source', icon: TfCode2 },
]

interface ArtifactView {
  source: ArtifactSource
  mode: ViewMode
  isRunApproved: boolean
}

function initialView(source: ArtifactSource): ArtifactView {
  return { source, mode: 'preview', isRunApproved: false }
}

function RunPreviewPrompt({ onRun }: { onRun: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <button
        type="button"
        onClick={onRun}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-chat"
      >
        <TfPlay className="h-3.5 w-3.5" aria-hidden="true" />
        Run preview
      </button>
      <p className="max-w-xs text-xs text-content-muted">
        HTML previews run in an isolated sandbox outside the verified app.
      </p>
    </div>
  )
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
  // The view is tied to the artifact it was chosen for and derived during
  // render, so a new artifact never renders a frame with the previous view.
  const [view, setView] = useState<ArtifactView>(() => initialView(source))
  const currentView = view.source === source ? view : initialView(source)
  const { mode } = currentView
  // HTML runs on the unverified sandbox, so it waits for an explicit click,
  // for every artifact shown in this panel.
  const canRunPreview = source.type !== 'html' || currentView.isRunApproved
  const isSidebarLayout = layout === 'sidebar'
  const copyText = sourceToCopyString(source)
  const tabsId = useId()
  const panelId = `${tabsId}-panel`
  const tabId = (tabMode: ViewMode) => `${tabsId}-${tabMode}-tab`

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
      <div className="border-b border-border-subtle bg-surface-chat-background px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
          {getSourceLabel(source)}
        </p>
        {title && <CardTitle className="mt-1 text-base">{title}</CardTitle>}
        {description && (
          <CardDescription className="mt-1">{description}</CardDescription>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="Artifact view"
            className="flex rounded-lg border border-border-subtle p-0.5"
          >
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.mode}
                id={tabId(tab.mode)}
                type="button"
                role="tab"
                aria-selected={mode === tab.mode}
                aria-controls={panelId}
                onClick={() => setView({ ...currentView, mode: tab.mode })}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  mode === tab.mode
                    ? 'bg-surface-chat text-content-primary'
                    : 'text-content-muted hover:text-content-primary',
                )}
              >
                <tab.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {source.type === 'url' && (
              <a
                href={safeArtifactUrl(source.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-6 items-center gap-1 rounded px-2 text-xs text-content-muted hover:bg-surface-card hover:text-content-primary"
              >
                <TfExternalLink className="h-3.5 w-3.5" />
                <span>Open</span>
              </a>
            )}
            <CopyButton text={copyText} />
          </div>
        </div>
      </div>
      <CardContent
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(mode)}
        className={cn(isSidebarLayout ? 'flex min-h-0 flex-1 p-0' : 'p-4')}
      >
        {mode === 'preview' ? (
          canRunPreview ? (
            <Preview
              source={source}
              title={title}
              className={
                isSidebarLayout ? getSidebarPreviewClassName(source) : undefined
              }
              shouldAutoFocusIframe={isSidebarLayout}
            />
          ) : (
            <RunPreviewPrompt
              onRun={() => setView({ ...currentView, isRunApproved: true })}
            />
          )
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
 * single click target that toggles the artifact sidebar, with a separate
 * download action beside it.
 */
function ArtifactPreviewInlineCard({
  title,
  description,
  source,
  footer,
  isSelected = false,
  shouldAutoOpen,
  toolCallId,
}: z.infer<typeof schema> & {
  isSelected?: boolean
  shouldAutoOpen?: boolean
  toolCallId?: string
}) {
  const hasAutoOpenedRef = useRef(false)
  const detail = useMemo<ArtifactPreviewSidebarDetail>(
    () => ({ title, description, source, footer }),
    [description, footer, source, title],
  )
  const displayTitle = title ?? getSourceLabel(source)
  const subtitle = description ?? getSourceLabel(source)

  useEffect(() => {
    if (
      !shouldAutoOpen ||
      hasAutoOpenedRef.current ||
      window.innerWidth < CONSTANTS.MOBILE_BREAKPOINT
    ) {
      return
    }
    hasAutoOpenedRef.current = true
    openArtifactPreviewSidebar(detail, 'open', toolCallId)
  }, [detail, shouldAutoOpen, toolCallId])

  return (
    <div
      className={cn(
        'my-3 flex w-full items-center rounded-lg border bg-surface-card text-left transition-colors',
        isSelected
          ? 'border-brand-accent-dark bg-brand-accent-dark/10 dark:border-brand-accent-light dark:bg-brand-accent-light/10'
          : 'border-border-subtle hover:bg-surface-chat-background',
      )}
    >
      <button
        type="button"
        onClick={() => openArtifactPreviewSidebar(detail, 'toggle', toolCallId)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 self-stretch px-4 py-4 text-left"
        aria-pressed={isSelected}
      >
        <FileText
          className={cn(
            'h-6 w-6 flex-shrink-0',
            isSelected
              ? 'text-brand-accent-dark dark:text-brand-accent-light'
              : 'text-content-muted',
          )}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-content-primary">
            {displayTitle}
          </span>
          <span className="whitespace-pre-wrap break-words text-xs leading-relaxed text-content-muted">
            {subtitle}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => downloadArtifact(source, title)}
        className="mr-4 inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-card"
        aria-label="Download artifact"
      >
        <TfDownload className="h-3.5 w-3.5" />
        Download
      </button>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_artifact_preview',
  schema,
  render: (args, { isActive, isStreaming, toolCallId }) => (
    <ArtifactPreviewInlineCard
      {...args}
      isSelected={isActive}
      shouldAutoOpen={isStreaming}
      toolCallId={toolCallId}
    />
  ),
})
