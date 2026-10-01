/**
 * Previews that must execute model-authored code (HTML, JavaScript, HTML
 * artifacts) run on the unverified sandbox origin, in a sandboxed iframe
 * with an opaque origin. Protocol (github.com/tinfoilsh/tinfoil-webapp-sandbox):
 * the frame is loaded with a per-frame nonce in the URL fragment and keeps
 * announcing `tinfoil-sandbox-ready` with that nonce until it receives a run;
 * we post one `tinfoil-sandbox-run` once a ready message echoes our nonce.
 * Output messages come back with the same `instanceId`, so existing
 * listeners keep working.
 */
import { SANDBOX_ORIGIN } from '@/config'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

export const SANDBOX_PREVIEW_URL = `${SANDBOX_ORIGIN}/preview`
const READY_TIMEOUT_MS = 15_000

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
  const nonce = useMemo(() => crypto.randomUUID(), [])
  const runRef = useRef(run)
  runRef.current = run
  const readyRef = useRef<Window | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // The frame's origin is opaque, so the target origin has to be '*'; the
    // nonce check is what ties the ready message to the document we loaded.
    const onMessage = (event: MessageEvent) => {
      const target = iframeRef.current?.contentWindow
      if (!target || event.source !== target) return
      if (event.data?.type !== 'tinfoil-sandbox-ready') return
      if (event.data.nonce !== nonce) return
      if (readyRef.current) return
      readyRef.current = target
      setFailed(false)
      if (runRef.current) target.postMessage(runRef.current, '*')
    }
    const timer = setTimeout(() => {
      if (!readyRef.current) setFailed(true)
    }, READY_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
  }, [iframeRef, nonce])

  // A new run after the frame is ready is posted immediately.
  useEffect(() => {
    if (run && readyRef.current) readyRef.current.postMessage(run, '*')
  }, [run])

  return { src: `${SANDBOX_PREVIEW_URL}#${nonce}`, failed }
}

export function SandboxUnavailable() {
  return (
    <div className="text-sm text-content-muted">
      Preview unavailable: the sandbox did not respond.
    </div>
  )
}
