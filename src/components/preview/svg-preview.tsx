/**
 * SVG preview — sanitizes an SVG string and renders it inline.
 *
 * Shared between the code-block renderer (which detects fenced `svg` blocks)
 * and the `render_image` GenUI component (which accepts structured SVG input).
 */
import DOMPurify from 'isomorphic-dompurify'

interface SvgPreviewProps {
  code: string
  className?: string
}

export function SvgPreview({ code, className }: SvgPreviewProps) {
  const sanitized = DOMPurify.sanitize(code, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })

  return (
    <div
      className={
        className ??
        'flex w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-h-[400px] [&>svg]:w-full [&>svg]:max-w-full'
      }
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  )
}
