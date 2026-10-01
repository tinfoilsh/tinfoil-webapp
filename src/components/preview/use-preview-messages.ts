import { useEffect, useId, useMemo, useRef, type RefObject } from 'react'

export type PreviewMessage = { type: string; instanceId: string } & Record<
  string,
  unknown
>

/**
 * Delivers messages posted by a preview frame to `onMessage`, after checking
 * that they come from that frame's window and carry this preview's
 * `instanceId`. Shared by every in-origin and sandbox preview so the
 * source/instance validation lives in one place.
 */
export function usePreviewMessages(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  instanceId: string,
  onMessage: (message: PreviewMessage) => void,
) {
  const handlerRef = useRef(onMessage)
  useEffect(() => {
    handlerRef.current = onMessage
  })

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as Partial<PreviewMessage> | null
      if (!data || typeof data !== 'object') return
      if (data.instanceId !== instanceId || typeof data.type !== 'string')
        return
      handlerRef.current(data as PreviewMessage)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [iframeRef, instanceId])
}

/**
 * One id per preview document. A code change replaces the document, and a
 * late message from the old one (a slow Python run, a Mermaid error) still
 * carries the old id, so `usePreviewMessages` drops it instead of letting it
 * overwrite the new preview.
 */
export function usePreviewInstanceId(code: string): string {
  const base = useId()
  const version = useRef(0)
  // `code` is the trigger, not an input: a new document needs a new id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => `${base}:${++version.current}`, [base, code])
}
