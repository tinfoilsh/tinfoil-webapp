/**
 * Mermaid preview — lazy-loads the mermaid library and renders a diagram
 * from source code. Shared between the code-block renderer and the
 * `render_image` GenUI component.
 */
import DOMPurify from 'isomorphic-dompurify'
import { useEffect, useMemo, useState } from 'react'

interface MermaidPreviewProps {
  code: string
  isDarkMode: boolean
  className?: string
}

export function MermaidPreview({
  code,
  isDarkMode,
  className,
}: MermaidPreviewProps) {
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const idRef = useMemo(
    () => `mermaid-${Math.random().toString(36).slice(2, 11)}`,
    [],
  )

  useEffect(() => {
    let cancelled = false

    const renderMermaid = async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkMode ? 'dark' : 'default',
          securityLevel: 'strict',
          // Render labels as SVG <text> nodes instead of wrapping them in
          // <foreignObject><div>...</div></foreignObject>, which DOMPurify
          // strips under its SVG profile.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
        })

        const { svg: renderedSvg } = await mermaid.render(idRef, code)
        if (!cancelled) {
          setSvg(renderedSvg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setSvg('')
        }
      }
    }

    renderMermaid()
    return () => {
      cancelled = true
    }
  }, [code, isDarkMode, idRef])

  if (error) {
    return <div className="text-sm text-red-500">Mermaid error: {error}</div>
  }

  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
  })

  return (
    <div
      className={
        className ??
        'flex w-full items-center justify-center [&>svg]:max-w-full'
      }
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  )
}
