/**
 * Mermaid preview. Renders in `/preview/mermaid.html`, a verified page on
 * this origin framed with an opaque origin. The page has its own CSP that
 * allows the inline styles Mermaid writes while rendering (scripts stay
 * 'self'), so the diagram source never leaves the verified origin and the
 * strict app-wide policy stays intact. The frame reports its height or an
 * error.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MERMAID_PREVIEW_URL,
  SandboxUnavailable,
  useSandboxRunner,
  type SandboxRun,
} from './sandbox-frame'
import {
  usePreviewInstanceId,
  usePreviewMessages,
} from './use-preview-messages'

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
  const instanceId = usePreviewInstanceId(code)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const run = useMemo<SandboxRun>(
    () => ({
      type: 'tinfoil-sandbox-run',
      kind: 'mermaid',
      instanceId,
      code,
      isDarkMode,
    }),
    [instanceId, code, isDarkMode],
  )
  const { src, failed } = useSandboxRunner(iframeRef, run, MERMAID_PREVIEW_URL)

  useEffect(() => setError(null), [run])
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

  return (
    <div className={className ?? 'w-full'}>
      {error && (
        <div className="text-sm text-red-500">Mermaid error: {error}</div>
      )}
      {failed && <SandboxUnavailable />}
      {/* Stays mounted through errors so the next diagram reuses the frame. */}
      <iframe
        ref={iframeRef}
        src={src}
        className={`w-full border-0${error || failed ? 'hidden' : ''}`}
        style={{ height: `${height}px` }}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="Mermaid preview"
      />
    </div>
  )
}
