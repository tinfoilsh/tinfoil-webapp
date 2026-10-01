import { useEffect, useRef, type RefObject } from 'react'

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
