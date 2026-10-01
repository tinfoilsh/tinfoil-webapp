/**
 * Previews that must execute model-authored code (HTML, JavaScript, HTML
 * artifacts) run on the unverified sandbox origin, in a sandboxed iframe
 * with an opaque origin. The frame announces itself with
 * `tinfoil-sandbox-ready`; we then post one `tinfoil-sandbox-run` message.
 * Output messages come back with the same `instanceId`, so existing
 * listeners keep working. Protocol: github.com/tinfoilsh/tinfoil-webapp-sandbox
 */
import { SANDBOX_ORIGIN } from '@/config'
import { useEffect, useRef, type RefObject } from 'react'

export const SANDBOX_PREVIEW_URL = `${SANDBOX_ORIGIN}/preview`

export type SandboxRun = {
  type: 'tinfoil-sandbox-run'
  kind: 'html' | 'js' | 'artifact'
  instanceId: string
  code?: string
  html?: string
}

export function useSandboxRunner(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  run: SandboxRun | null,
) {
  const runRef = useRef(run)
  runRef.current = run
  const readyRef = useRef<Window | null>(null)

  // Every ready announcement gets the current run: the frame may reload.
  // The frame's origin is opaque, so the target origin has to be '*'.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = iframeRef.current?.contentWindow
      if (!target || event.source !== target) return
      if (event.data?.type !== 'tinfoil-sandbox-ready') return
      readyRef.current = target
      if (runRef.current) target.postMessage(runRef.current, '*')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [iframeRef])

  // A new run after the frame is ready is posted immediately.
  useEffect(() => {
    if (run && readyRef.current) readyRef.current.postMessage(run, '*')
  }, [run])
}
