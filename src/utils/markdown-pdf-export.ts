/**
 * Exports a rendered markdown subtree as a PDF with a forced light theme.
 *
 * Why this exists:
 *   The markdown preview uses the Tailwind Typography plugin (`prose`) and a
 *   pile of app-specific rules in `globals.css` that colour everything via
 *   `color: hsl(var(--content-primary)) !important`. In dark mode
 *   `--content-primary` resolves to near-white, so a naive capture produces a
 *   PDF with ghost-white text on a white background.
 *
 *   Rather than fighting every rule individually, we clone the subtree and
 *   override the handful of CSS custom properties those rules actually read.
 *   Everything else (prose spacing, heading scale, list indentation, code
 *   block chrome, etc.) continues to render exactly as on screen.
 *
 * Guarantees:
 *   - Body text resolves dark on a white background.
 *   - Fonts are pinned to Helvetica (body) and a monospace stack (code).
 *   - The live preview is not mutated.
 */

// Light-theme HSL triplets (H S% L%) for the theme tokens that drive text and
// surface colours in the markdown preview. These mirror the `:root` values in
// `src/styles/tailwind.css`.
const LIGHT_THEME_TOKENS: Record<string, string> = {
  '--content-primary': '221 39.3% 11%',
  '--content-secondary': '221 20% 20%',
  '--content-muted': '221 14% 34%',
  '--content-inverse': '0 0% 100%',
  '--border-subtle': '220 13% 91%',
  '--border-strong': '217 19.1% 26.7%',
  '--muted': '220 14% 95%',
  '--surface-chat-background': '0 0% 100%',
  '--surface-card': '0 0% 100%',
  '--surface-input': '220 14% 95%',
}

const PDF_BODY_FONT = 'Helvetica, Arial, sans-serif'
const PDF_MONO_FONT = 'ui-monospace, Menlo, Consolas, monospace'

const MONO_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP'])
const LAYOUT_SETTLE_MS = 30

type PdfMargin = number | [number, number] | [number, number, number, number]

type Html2PdfOptions = {
  filename?: string
  margin?: PdfMargin
}

/**
 * Render `source` into a PDF file and trigger a download.
 *
 * The source element must be attached to the live DOM (so we can measure its
 * intrinsic width). Its classes, content, and inline styles are preserved in
 * an off-screen clone; only a small number of theme-related CSS variables are
 * overridden so the clone always renders in light mode.
 */
export async function downloadMarkdownAsPdf(
  source: HTMLElement,
  {
    filename = 'document.pdf',
    margin = [10, 10, 10, 10],
  }: Html2PdfOptions = {},
): Promise<void> {
  const wrapper = createLightThemeWrapper(source.scrollWidth)
  const clone = source.cloneNode(true) as HTMLElement

  applyLightThemeTokens(clone)
  applyPdfFonts(clone)
  expandOverflowingContainers(clone)

  wrapper.appendChild(clone)
  document.body.appendChild(wrapper)

  try {
    // Let layout settle (fonts, images, etc.) before html2canvas measures.
    await new Promise((resolve) => setTimeout(resolve, LAYOUT_SETTLE_MS))

    const html2pdf = (await import('html2pdf.js')).default
    // Keep block-level elements intact across page boundaries so headings,
    // paragraphs, list items, tables, and code blocks aren't sliced in half.
    // `pagebreak` is a real html2pdf option but its published TS typings omit
    // it, hence the cast below.
    const opts = {
      margin,
      filename,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff' },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait' as const,
      },
      pagebreak: {
        mode: ['css', 'legacy'],
        avoid: [
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'p',
          'li',
          'tr',
          'thead',
          'blockquote',
          'pre',
          'img',
          'figure',
        ],
      },
    }
    const pdfUrl: string = await html2pdf()
      .set(opts)
      .from(clone)
      .output('bloburl')
    window.open(pdfUrl, '_blank', 'noopener,noreferrer')
  } finally {
    wrapper.remove()
  }
}

function createLightThemeWrapper(sourceWidth: number): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('aria-hidden', 'true')

  const style = wrapper.style
  style.setProperty('position', 'fixed', 'important')
  style.setProperty('top', '-10000px', 'important')
  style.setProperty('left', '0', 'important')
  style.setProperty('width', `${Math.max(sourceWidth, 800)}px`, 'important')
  style.setProperty('padding', '16px', 'important')
  style.setProperty('background-color', '#ffffff', 'important')
  style.setProperty('color-scheme', 'light', 'important')

  // Pin every theme token that app CSS resolves via `hsl(var(--...))`. Because
  // these are inline on the wrapper with !important, they win over both the
  // `:root` defaults and the `.dark { ... }` overrides on `<html>`, for
  // everything inside the wrapper.
  for (const [name, value] of Object.entries(LIGHT_THEME_TOKENS)) {
    style.setProperty(name, value, 'important')
  }

  return wrapper
}

function applyLightThemeTokens(clone: HTMLElement): void {
  // Re-apply on the clone itself as well so CSS rules that specifically match
  // the `.prose` root (e.g. `.prose { color: hsl(var(--content-primary)) }`)
  // pick up the light palette even when the rule's selector doesn't see the
  // wrapper.
  for (const [name, value] of Object.entries(LIGHT_THEME_TOKENS)) {
    clone.style.setProperty(name, value, 'important')
  }
}

function applyPdfFonts(clone: HTMLElement): void {
  const elements: HTMLElement[] = [
    clone,
    ...Array.from(clone.querySelectorAll<HTMLElement>('*')),
  ]
  for (const el of elements) {
    const isMono = MONO_TAGS.has(el.tagName)
    el.style.setProperty(
      'font-family',
      isMono ? PDF_MONO_FONT : PDF_BODY_FONT,
      'important',
    )
  }
}

function expandOverflowingContainers(clone: HTMLElement): void {
  // html2canvas captures the element's layout box, so overflow:auto/hidden
  // regions get clipped. Force them visible on the clone so wide tables and
  // code blocks render in full.
  clone
    .querySelectorAll<HTMLElement>('table, [style*="overflow"]')
    .forEach((el) => el.style.setProperty('overflow', 'visible', 'important'))
}
