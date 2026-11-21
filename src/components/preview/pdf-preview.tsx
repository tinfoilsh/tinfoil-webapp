/**
 * Renders PDF bytes page by page onto canvases with pdf.js, which is copied
 * to `public/vendor/pdfjs/` by `copy-vendor.mjs` and imported by URL at
 * runtime (its worker must come from this origin for the CSP's worker-src).
 * Drawing to canvas avoids framing a blob: URL, which the CSP forbids and
 * which mobile browsers render poorly anyway.
 */
import { cn } from '@/components/ui/utils'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'

type PdfJs = typeof import('pdfjs-dist')
const PDFJS_URL = '/vendor/pdfjs/pdf.mjs'
const PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.mjs'
const RENDER_SCALE = 1.5

let pdfjs: Promise<PdfJs> | null = null
function getPdfJs(): Promise<PdfJs> {
  pdfjs ??= import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ PDFJS_URL
  ).then((module: PdfJs) => {
    module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
    return module
  })
  return pdfjs
}

export function PdfPreview({
  data,
  className,
}: {
  data: Uint8Array
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    setError(null)
    ;(async () => {
      const lib = await getPdfJs()
      // pdf.js transfers the buffer to its worker, so hand it a copy.
      task = lib.getDocument({ data: data.slice() })
      const doc = await task.promise
      if (cancelled) return
      container.replaceChildren()
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n)
        if (cancelled) return
        const viewport = page.getViewport({ scale: RENDER_SCALE })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.className = 'mb-3 h-auto w-full bg-white shadow'
        canvas.setAttribute('aria-label', `Page ${n}`)
        container.appendChild(canvas)
        await page.render({ canvas, viewport }).promise
      }
    })().catch((cause: unknown) => {
      if (!cancelled)
        setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [data])

  return (
    <div className={cn('overflow-auto', className)}>
      {error && (
        <p className="p-3 text-xs text-red-600 dark:text-red-400">
          Could not display the PDF: {error}
        </p>
      )}
      <div ref={containerRef} />
    </div>
  )
}
