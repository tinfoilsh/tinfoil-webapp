/**
 * Mermaid preview. Renders in an in-origin srcdoc frame: the diagram source
 * is JSON data processed by `/preview/mermaid-run.js` with the pinned
 * Mermaid build under `/vendor/mermaid/`, so no inline script, no eval, no
 * inline styles, and the payload stays within the verified origin. Output is
 * SVG; the frame reports its height or an error.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { buildRunnerDocument } from './runner-frame'
import { usePreviewMessages } from './use-preview-messages'

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
  const [height, setHeight] = useState(100)
  const [error, setError] = useState<string | null>(null)
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const srcDoc = useMemo(
    () =>
      buildRunnerDocument({
        script: '/preview/mermaid-run.js',
        data: { code, isDarkMode, instanceId },
      }),
    [code, isDarkMode, instanceId],
  )

  useEffect(() => setError(null), [srcDoc])
  usePreviewMessages(iframeRef, instanceId, (message) => {
    if (
      message.type === 'mermaid-preview-height' &&
      Number.isFinite(message.height)
    ) {
      setHeight(Math.min(2000, Math.max(50, message.height as number)))
    }
    if (
      message.type === 'mermaid-preview-error' &&
      typeof message.message === 'string'
    ) {
      setError(message.message.slice(0, 500))
    }
  })

  if (error) {
    return <div className="text-sm text-red-500">Mermaid error: {error}</div>
  }

  return (
    <div className={className ?? 'w-full'}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        className="w-full border-0"
        style={{ height: `${height}px` }}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="Mermaid preview"
      />
    </div>
  )
}
