/**
 * LatexDocument widget.
 *
 * The model picks one of the LaTeX templates, fills its personalization
 * macros and (optionally) the document body; the card compiles the result
 * in the browser with tstex and shows the PDF in the artifact sidebar via
 * the same `OPEN_ARTIFACT_PREVIEW_EVENT` the artifact preview widget uses.
 * A failed compile asks the model once to repair its arguments with the
 * TeX error excerpt, then leaves a manual retry.
 */
import { CONSTANTS } from '@/components/chat/constants'
import { cn } from '@/components/ui/utils'
import { compileLatex, summarizeLatexLog } from '@/services/latex/compile'
import {
  LATEX_BASE_STYLE,
  LATEX_TEMPLATES,
  LATEX_TEMPLATE_NAMES,
  fillTemplate,
  loadTemplateSources,
} from '@/services/latex/templates'
import { TfDownload, TfRefreshTwoArrows } from '@tinfoilsh/tinfoil-icons'
import { FileText, ImagePlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'
import {
  openArtifactPreviewSidebar,
  type ArtifactPreviewSidebarDetail,
  type LatexSidebarSource,
} from './ArtifactPreview'

const LOGO_STORAGE_KEY = 'tinfoil:latex-logo'
const LOGO_CHANGED_EVENT = 'tinfoil:latex-logo-changed'
const LOGO_MAX_BYTES = 1_000_000

const templateList = LATEX_TEMPLATE_NAMES.map(
  (name) =>
    `${name}: ${LATEX_TEMPLATES[name].description}; fields ${LATEX_TEMPLATES[name].fields.join(', ')}`,
).join('. ')

const schema = z.object({
  template: z
    .enum(LATEX_TEMPLATE_NAMES)
    .describe(`Template to start from. ${templateList}.`),
  title: z
    .string()
    .optional()
    .describe('Short label for the card, also used as the PDF file name'),
  fields: z
    .record(z.string())
    .optional()
    .describe(
      'Values for the template\'s personalization macros keyed by macro name without backslash, e.g. {"SenderName":"Ada Lovelace"}. Values are LaTeX; use \\\\ for line breaks inside address blocks.',
    ),
  body: z
    .string()
    .optional()
    .describe(
      'LaTeX replacing the sample content between \\begin{document} and \\end{document}. Omit to keep the template sample. Available: booktabs tables, amsmath, \\lab{label}, \\twocol{left}{right}, keybox environment, \\hairline, \\accentbar. Not available: enumitem, titlesec, tcolorbox, multicol, tabularx, colortbl, \\textbullet (use $\\bullet$), fonts other than Computer Modern and Times.',
    ),
  latex: z
    .string()
    .optional()
    .describe(
      'Full LaTeX source compiled verbatim instead of the template; keep \\usepackage{tinfoil-base}. Use only when the user supplies their own document.',
    ),
})

type Args = z.infer<typeof schema>

type CompileState =
  | { status: 'compiling' }
  | { status: 'ready'; pdf: Uint8Array; pages: number }
  | { status: 'error'; error: string }

function readLogo(): Uint8Array | null {
  if (typeof window === 'undefined') return null
  const dataUrl = localStorage.getItem(LOGO_STORAGE_KEY)
  const base64 = dataUrl?.split(',')[1]
  if (!base64) return null
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

/** Count `/Type /Page` objects; pdfTeX writes one per page, uncompressed. */
function countPages(pdf: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(pdf)
  return text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0
}

function useLatexSource(args: Args): string | null {
  const [source, setSource] = useState<string | null>(null)
  const { template, fields, body, latex } = args
  const fieldsKey = JSON.stringify(fields ?? {})
  useEffect(() => {
    if (latex) {
      setSource(latex)
      return
    }
    let cancelled = false
    setSource(null)
    loadTemplateSources(template)
      .then(({ main }) => {
        if (!cancelled) setSource(fillTemplate(main, fields, body))
      })
      .catch(() => {
        if (!cancelled) setSource('')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, fieldsKey, body, latex])
  return source
}

function useLogoVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    window.addEventListener(LOGO_CHANGED_EVENT, bump)
    return () => window.removeEventListener(LOGO_CHANGED_EVENT, bump)
  }, [])
  return version
}

function useCompile(source: string | null): CompileState {
  const [state, setState] = useState<CompileState>({ status: 'compiling' })
  const logoVersion = useLogoVersion()
  useEffect(() => {
    if (source === null) {
      setState({ status: 'compiling' })
      return
    }
    if (source === '') {
      setState({ status: 'error', error: 'The template could not be loaded.' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'compiling' })
    ;(async () => {
      const { base } = await loadTemplateSources('letter')
      const files: Record<string, string | Uint8Array> = {
        'main.tex': source,
        [LATEX_BASE_STYLE]: base,
      }
      const logo = readLogo()
      if (logo) files['logo.png'] = logo
      const result = await compileLatex(files, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok && result.pdf) {
        setState({
          status: 'ready',
          pdf: result.pdf,
          pages: countPages(result.pdf),
        })
      } else {
        setState({ status: 'error', error: summarizeLatexLog(result.log) })
      }
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setState({
        status: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      })
    })
    return () => controller.abort()
  }, [source, logoVersion])
  return state
}

function storeLogo(event: ChangeEvent<HTMLInputElement>): void {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || file.type !== 'image/png' || file.size > LOGO_MAX_BYTES) return
  const reader = new FileReader()
  reader.onload = () => {
    localStorage.setItem(LOGO_STORAGE_KEY, String(reader.result))
    window.dispatchEvent(new Event(LOGO_CHANGED_EVENT))
  }
  reader.readAsDataURL(file)
}

function downloadPdf(pdf: Uint8Array, title: string | undefined): void {
  const base =
    (title ?? 'document').trim().replace(/[^\w.-]+/g, '-') || 'document'
  const url = URL.createObjectURL(
    new Blob([pdf as BlobPart], { type: 'application/pdf' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function statusText(state: CompileState, repairing: boolean): string {
  if (repairing) return 'Asking the model to fix the LaTeX…'
  switch (state.status) {
    case 'compiling':
      return 'Compiling PDF…'
    case 'ready':
      return `PDF ready, ${state.pages} page${state.pages === 1 ? '' : 's'}`
    case 'error':
      return 'Compile failed'
  }
}

function LatexDocumentCard({
  args,
  isActive,
  isStreaming,
  toolCallId,
  retryToolCall,
}: {
  args: Args
  isActive: boolean
  isStreaming: boolean
  toolCallId?: string
  retryToolCall?: (reason: string) => Promise<boolean>
}) {
  const source = useLatexSource(args)
  const state = useCompile(source)
  const [repairing, setRepairing] = useState(false)
  const repairedForRef = useRef<string | null>(null)
  const hasAutoOpenedRef = useRef(false)
  const title = args.title ?? LATEX_TEMPLATES[args.template].description

  const detail = useMemo<ArtifactPreviewSidebarDetail | null>(() => {
    if (source === null) return null
    const latexSource: LatexSidebarSource = {
      type: 'latex',
      latex: source,
      ...(state.status === 'ready'
        ? { status: 'ready', pdf: state.pdf }
        : state.status === 'error'
          ? { status: 'error', error: state.error }
          : { status: 'compiling' }),
    }
    return { title, source: latexSource }
  }, [source, state, title])

  // One automatic repair per set of arguments: a new attempt means the
  // arguments changed, so the source changes and compilation reruns.
  const argsKey = JSON.stringify(args)
  useEffect(() => {
    if (
      state.status !== 'error' ||
      !retryToolCall ||
      repairedForRef.current === argsKey
    ) {
      return
    }
    repairedForRef.current = argsKey
    setRepairing(true)
    retryToolCall(`The LaTeX failed to compile:\n${state.error}`)
      .catch(() => false)
      .finally(() => setRepairing(false))
  }, [state, retryToolCall, argsKey])

  // Keep the sidebar in step with compilation while it shows this card.
  useEffect(() => {
    if (!detail) return
    const shouldOpen =
      isActive ||
      (isStreaming &&
        !hasAutoOpenedRef.current &&
        window.innerWidth >= CONSTANTS.MOBILE_BREAKPOINT)
    if (!shouldOpen) return
    hasAutoOpenedRef.current = true
    openArtifactPreviewSidebar(detail, 'open', toolCallId)
  }, [detail, isActive, isStreaming, toolCallId])

  return (
    <div
      className={cn(
        'my-3 flex w-full items-center rounded-lg border bg-surface-card text-left transition-colors',
        isActive
          ? 'border-brand-accent-dark bg-brand-accent-dark/10 dark:border-brand-accent-light dark:bg-brand-accent-light/10'
          : 'border-border-subtle hover:bg-surface-chat-background',
      )}
    >
      <button
        type="button"
        onClick={() =>
          detail && openArtifactPreviewSidebar(detail, 'toggle', toolCallId)
        }
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 self-stretch px-4 py-4 text-left"
        aria-pressed={isActive}
      >
        {state.status === 'compiling' || repairing ? (
          <PiSpinner
            className="h-6 w-6 flex-shrink-0 animate-spin text-content-muted"
            aria-hidden
          />
        ) : (
          <FileText
            className={cn(
              'h-6 w-6 flex-shrink-0',
              state.status === 'error'
                ? 'text-red-500'
                : isActive
                  ? 'text-brand-accent-dark dark:text-brand-accent-light'
                  : 'text-content-muted',
            )}
            aria-hidden
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-content-primary">
            {title}
          </span>
          <span className="text-xs leading-relaxed text-content-muted">
            {statusText(state, repairing)}
          </span>
        </span>
      </button>
      <div className="mr-4 flex flex-shrink-0 items-center gap-2">
        <label
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-card"
          title="Use a PNG logo in letterheads, CV and invoices"
        >
          <ImagePlus className="h-3.5 w-3.5" aria-hidden />
          Logo
          <input
            type="file"
            accept="image/png"
            className="sr-only"
            onChange={storeLogo}
          />
        </label>
        {state.status === 'error' && retryToolCall && !repairing && (
          <button
            type="button"
            onClick={() => {
              setRepairing(true)
              retryToolCall(`The LaTeX failed to compile:\n${state.error}`)
                .catch(() => false)
                .finally(() => setRepairing(false))
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-card"
          >
            <TfRefreshTwoArrows className="h-3.5 w-3.5" aria-hidden />
            Fix
          </button>
        )}
        {state.status === 'ready' && (
          <button
            type="button"
            onClick={() => downloadPdf(state.pdf, args.title)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-card"
            aria-label="Download PDF"
          >
            <TfDownload className="h-3.5 w-3.5" aria-hidden />
            PDF
          </button>
        )}
      </div>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_latex_document',
  description:
    "Typeset a PDF document with LaTeX from a template: letters, CV, report, slides, academic paper, invoice, contract or notes. Fill the template's personalization fields from what the user said and write the document body in LaTeX. The chat shows a card; the PDF opens in the side panel and can be downloaded. Do not paste the LaTeX in the message as well.",
  schema,
  promptHint:
    'typeset PDF documents (letters, CV, invoice, contract, report, paper, notes, slides) from templates when the user wants a finished, printable document',
  render: (args, { isActive, isStreaming, toolCallId, retryToolCall }) => (
    <LatexDocumentCard
      args={args}
      isActive={Boolean(isActive)}
      isStreaming={Boolean(isStreaming)}
      toolCallId={toolCallId}
      retryToolCall={retryToolCall}
    />
  ),
})
