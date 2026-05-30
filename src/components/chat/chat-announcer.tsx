import { useEffect, useRef } from 'react'
import type { Message } from './types'

const RESPONDING_ANNOUNCEMENT = 'Tin is responding'

type ChatAnnouncerProps = {
  messages: Message[]
  isStreaming: boolean
  isWaitingForResponse: boolean
}

/**
 * Off-screen polite live region that makes streamed assistant responses
 * perceivable to screen-reader users.
 *
 * Streaming text is intentionally NOT wrapped in a live region: announcing
 * token-by-token restarts the utterance on every chunk. Instead this announces
 * a short "responding" notice when generation starts and the full response once
 * it completes. The text is written imperatively so the screen reader (an
 * external system) is the only consumer and React never clobbers it.
 */
export function ChatAnnouncer({
  messages,
  isStreaming,
  isWaitingForResponse,
}: ChatAnnouncerProps) {
  const liveRegionRef = useRef<HTMLDivElement>(null)
  const wasGeneratingRef = useRef(false)

  const isGenerating = isStreaming || isWaitingForResponse

  useEffect(() => {
    const wasGenerating = wasGeneratingRef.current
    wasGeneratingRef.current = isGenerating

    const region = liveRegionRef.current
    if (!region) return

    if (isGenerating && !wasGenerating) {
      region.textContent = RESPONDING_ANNOUNCEMENT
      return
    }

    if (!isGenerating && wasGenerating) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'assistant') {
        const text = lastMessage.content?.trim()
        if (text) region.textContent = text
      }
    }
  }, [isGenerating, messages])

  return (
    <div
      ref={liveRegionRef}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    />
  )
}
