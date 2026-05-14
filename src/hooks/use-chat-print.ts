import { toast } from '@/hooks/use-toast'
import { useCallback, useEffect, useState } from 'react'

const LIGHT_THEME_TOKENS: Record<string, string> = {
  '--content-primary': '221 39.3% 11%',
  '--content-secondary': '221 20% 20%',
  '--content-muted': '221 14% 34%',
  '--content-inverse': '0 0% 100%',
  '--border-subtle': '220 13% 91%',
  '--border-strong': '217 19.1% 26.7%',
  '--muted': '240 23.8% 95.9%',
  '--surface-chat-background': '0 0% 100%',
  '--surface-card': '0 0% 100%',
  '--surface-input': '240 23.8% 95.9%',
}

const LAYOUT_SETTLE_MS = 50

const PDF_BODY_FONT = 'Helvetica, Arial, sans-serif'
const PDF_MONO_FONT = 'ui-monospace, Menlo, Consolas, monospace'

const MONO_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP'])

interface UseChatPrintOptions {
  printRef: React.RefObject<HTMLDivElement | null>
  enabled?: boolean
}

interface UseChatPrintReturn {
  isGeneratingPdf: boolean
  triggerPrint: () => Promise<void>
}

export function useChatPrint({
  printRef,
  enabled = true,
}: UseChatPrintOptions): UseChatPrintReturn {
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false)

  const triggerPrint = useCallback(async () => {
    if (!printRef.current || isGeneratingPdf) return

    setIsGeneratingPdf(true)
    const element = printRef.current
    const wrapper = createPrintableWrapper(element.scrollWidth)
    const clone = element.cloneNode(true) as HTMLElement

    clone.classList.remove('hidden')
    clone.removeAttribute('aria-hidden')
    applyLightThemeTokens(clone)
    applyPdfFonts(clone)
    expandOverflowingContainers(clone)
    wrapper.appendChild(clone)
    document.body.appendChild(wrapper)

    try {
      // Wait for any web fonts to finish loading before html2canvas measures
      // glyphs, otherwise the rasterizer uses pre-computed Aeonik metrics
      // against fallback glyphs and produces kerning artifacts.
      if (typeof document !== 'undefined' && 'fonts' in document) {
        try {
          await document.fonts.ready
        } catch {
          // Ignore; fall through to the timed settle below.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LAYOUT_SETTLE_MS))

      const html2pdf = (await import('html2pdf.js')).default
      const opts = {
        margin: [15, 15, 15, 15] as [number, number, number, number],
        filename: 'chat.pdf',
        image: { type: 'jpeg' as const, quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          letterRendering: true,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait' as const,
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: [
            '.printable-role-header',
            '.printable-documents',
            '.printable-thinking',
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
      const blob: Blob = await html2pdf()
        .set(opts)
        .from(clone)
        .outputPdf('blob')

      const pdfUrl = URL.createObjectURL(blob)
      const printWindow = window.open(pdfUrl, '_blank')

      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print()
        }
      }

      setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000)
    } catch {
      toast({ title: 'Failed to generate PDF', variant: 'destructive' })
    } finally {
      wrapper.remove()
      setIsGeneratingPdf(false)
    }
  }, [printRef, isGeneratingPdf])

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        triggerPrint()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, triggerPrint])

  return {
    isGeneratingPdf,
    triggerPrint,
  }
}

function createPrintableWrapper(sourceWidth: number): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('aria-hidden', 'true')

  const style = wrapper.style
  style.setProperty('position', 'fixed', 'important')
  style.setProperty('top', '-10000px', 'important')
  style.setProperty('left', '0', 'important')
  style.setProperty('width', `${Math.max(sourceWidth, 800)}px`, 'important')
  style.setProperty('background-color', '#ffffff', 'important')
  style.setProperty('color', '#000000', 'important')
  style.setProperty('color-scheme', 'light', 'important')

  for (const [name, value] of Object.entries(LIGHT_THEME_TOKENS)) {
    style.setProperty(name, value, 'important')
  }

  return wrapper
}

function applyLightThemeTokens(clone: HTMLElement): void {
  const elements: HTMLElement[] = [
    clone,
    ...Array.from(clone.querySelectorAll<HTMLElement>('*')),
  ]

  for (const el of elements) {
    for (const [name, value] of Object.entries(LIGHT_THEME_TOKENS)) {
      el.style.setProperty(name, value, 'important')
    }
    el.style.setProperty('color-scheme', 'light', 'important')
  }
}

function applyPdfFonts(clone: HTMLElement): void {
  // Aeonik is loaded by Next/font as a variable font. html2canvas can't
  // reliably rasterize variable fonts and produces overlapping glyphs / wrong
  // kerning. Pinning every element to Helvetica (or a monospace stack for
  // code blocks) keeps text shaping consistent across measurement and paint.
  // Syntax-highlighted code wraps tokens in nested <span>s under <pre>/<code>,
  // so we check the ancestor chain — not just the element's own tag — to keep
  // every glyph inside a code block in the monospace stack.
  const elements: HTMLElement[] = [
    clone,
    ...Array.from(clone.querySelectorAll<HTMLElement>('*')),
  ]
  const monoSelector = Array.from(MONO_TAGS).join(',').toLowerCase()
  for (const el of elements) {
    const isMono =
      MONO_TAGS.has(el.tagName) || el.closest(monoSelector) !== null
    el.style.setProperty(
      'font-family',
      isMono ? PDF_MONO_FONT : PDF_BODY_FONT,
      'important',
    )
    el.style.setProperty('font-variation-settings', 'normal', 'important')
    el.style.setProperty('font-feature-settings', 'normal', 'important')
  }
}

function expandOverflowingContainers(clone: HTMLElement): void {
  clone
    .querySelectorAll<HTMLElement>('table, pre, [style*="overflow"]')
    .forEach((el) => el.style.setProperty('overflow', 'visible', 'important'))
}
