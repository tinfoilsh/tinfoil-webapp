/** Render SVG in an image context so its layout stays within the preview. */
import DOMPurify from 'isomorphic-dompurify'

interface SvgPreviewProps {
  code: string
  className?: string
}

export function SvgPreview({ code, className }: SvgPreviewProps) {
  const svg = DOMPurify.sanitize(code, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    RETURN_DOM_FRAGMENT: true,
  }).querySelector('svg')

  if (!svg) return null
  const svgDocument = svg.ownerDocument.implementation.createDocument(null, '')
  svgDocument.appendChild(svgDocument.importNode(svg, true))

  return (
    <div className={className ?? 'flex w-full items-center justify-center'}>
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDocument.documentElement.outerHTML)}`}
        alt="SVG preview"
        className="h-auto max-h-[400px] w-full max-w-full"
      />
    </div>
  )
}
