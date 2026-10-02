/**
 * Previews that must execute model-authored code (HTML, JavaScript, HTML
 * artifacts) run on the unverified sandbox origin, in a sandboxed iframe
 * with an opaque origin; the Mermaid page on this origin speaks the same
 * protocol. Protocol (github.com/tinfoilsh/tinfoil-webapp-sandbox):
 * the frame is loaded with a per-frame nonce in the URL fragment and keeps
 * announcing `tinfoil-sandbox-ready` with that nonce until it receives a run;
 * we post one `tinfoil-sandbox-run` once a ready message echoes our nonce.
 * Output messages come back with the same `instanceId`, so existing
 * listeners keep working.
 */
import { SANDBOX_ORIGIN } from '@/config'
import { useEffect, useRef, useState, type RefObject } from 'react'

/** Model code runs here (opaque frame). */
export const SANDBOX_PREVIEW_URL = `${SANDBOX_ORIGIN}/preview`
/** Tinfoil's Apple Maps embed (same-origin frame). */
export const SANDBOX_MAP_URL = `${SANDBOX_ORIGIN}/map`
/** Mermaid, on this origin: a verified page whose own CSP allows the inline styles Mermaid needs. */
export const MERMAID_PREVIEW_URL = '/preview/mermaid.html'
const READY_TIMEOUT_MS = 15_000

export type SandboxRun =
  | {
      type: 'tinfoil-sandbox-run'
      kind: 'html' | 'js'
      instanceId: string
      code: string
    }
  | {
      type: 'tinfoil-sandbox-run'
      kind: 'artifact'
      instanceId: string
      html: string
    }
  | {
      type: 'tinfoil-sandbox-run'
      kind: 'mermaid'
      instanceId: string
      code: string
      isDarkMode: boolean
    }
  | {
      type: 'tinfoil-sandbox-run'
      kind: 'map'
      instanceId: string
      locations: Array<Record<string, unknown>>
      mode?: string
      query?: string
      mapType?: string
      isDarkMode?: boolean
    }

export function useSandboxRunner(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  run: SandboxRun | null,
  url: string = SANDBOX_PREVIEW_URL,
) {
  // Generated after mount so server and client never disagree about the
  // nonce the frame was loaded with; the frame has no src until then.
  const [nonce, setNonce] = useState<string | null>(null)
  useEffect(() => setNonce(crypto.randomUUID()), [])
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  const readyRef = useRef<Window | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!nonce) return
    // The frame's origin is opaque, so the target origin has to be '*'; the
    // nonce check is what ties the ready message to the document we loaded.
    const onMessage = (event: MessageEvent) => {
      const target = iframeRef.current?.contentWindow
      if (!target || event.source !== target) return
      if (event.data?.type !== 'tinfoil-sandbox-ready') return
      if (event.data.nonce !== nonce) return
      // The frame keeps announcing until it gets a run; a remounted frame
      // element is a new window and gets the run again.
      if (readyRef.current === target) return
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

  return {
    src: nonce ? `${url}#${nonce}` : undefined,
    failed,
  }
}

export function SandboxUnavailable() {
  return (
    <div className="text-sm text-content-muted">
      Preview unavailable: the preview frame did not respond.
    </div>
  )
}
