import { useCallback, useRef, useState } from 'react'
import type { LoadingState } from '../types'

export interface RetryInfo {
  attempt: number
  maxRetries: number
  error?: string
}

/**
 * UI-facing state for a single chat's in-flight stream. One entry exists
 * per actively-streaming chat; the absence of an entry means the chat is
 * idle (see `IDLE_STREAM_STATUS`).
 *
 * `streamError` outlives the stream itself: it is preserved when the
 * stream settles so the floating error banner can surface when the user
 * navigates back to the chat that failed.
 */
export interface ChatStreamStatus {
  loadingState: LoadingState
  retryInfo: RetryInfo | null
  isThinking: boolean
  isWaitingForResponse: boolean
  isStreaming: boolean
  streamError: string | null
}

export const IDLE_STREAM_STATUS: ChatStreamStatus = {
  loadingState: 'idle',
  retryInfo: null,
  isThinking: false,
  isWaitingForResponse: false,
  isStreaming: false,
  streamError: null,
}

export interface UseChatStreamsReturn {
  statusByChat: Record<string, ChatStreamStatus>
  /** Merge a partial status into the chat's existing (or idle) status. */
  patchStatus: (chatId: string, partial: Partial<ChatStreamStatus>) => void
  /** Reset to idle, optionally overriding specific fields. */
  resetStatus: (chatId: string, partial?: Partial<ChatStreamStatus>) => void
  /** Re-key a chat's status and abort controller after a server id swap. */
  moveStatus: (fromId: string, toId: string) => void
  registerController: (chatId: string, controller: AbortController) => void
  clearController: (chatId: string) => void
  /** Abort the stream for a chat. Returns true if a controller existed. */
  abort: (chatId: string) => boolean
}

/**
 * Owns per-chat stream status so multiple chats can stream concurrently.
 *
 * Status flags live in React state (they drive the input area, stop
 * button, and thinking indicators for whichever chat is on screen). Abort
 * controllers live in a ref since aborting never needs to trigger a
 * render.
 */
export function useChatStreams(): UseChatStreamsReturn {
  const [statusByChat, setStatusByChat] = useState<
    Record<string, ChatStreamStatus>
  >({})
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())

  const patchStatus = useCallback(
    (chatId: string, partial: Partial<ChatStreamStatus>) => {
      setStatusByChat((prev) => {
        const current = prev[chatId] ?? IDLE_STREAM_STATUS
        return { ...prev, [chatId]: { ...current, ...partial } }
      })
    },
    [],
  )

  const resetStatus = useCallback(
    (chatId: string, partial?: Partial<ChatStreamStatus>) => {
      setStatusByChat((prev) => ({
        ...prev,
        [chatId]: { ...IDLE_STREAM_STATUS, ...partial },
      }))
    },
    [],
  )

  const moveStatus = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return

    setStatusByChat((prev) => {
      if (!(fromId in prev)) return prev
      const next = { ...prev }
      next[toId] = prev[fromId]
      delete next[fromId]
      return next
    })

    const controller = abortControllersRef.current.get(fromId)
    if (controller) {
      abortControllersRef.current.delete(fromId)
      abortControllersRef.current.set(toId, controller)
    }
  }, [])

  const registerController = useCallback(
    (chatId: string, controller: AbortController) => {
      abortControllersRef.current.set(chatId, controller)
    },
    [],
  )

  const clearController = useCallback((chatId: string) => {
    abortControllersRef.current.delete(chatId)
  }, [])

  const abort = useCallback((chatId: string): boolean => {
    const controller = abortControllersRef.current.get(chatId)
    if (!controller) return false
    controller.abort()
    abortControllersRef.current.delete(chatId)
    return true
  }, [])

  return {
    statusByChat,
    patchStatus,
    resetStatus,
    moveStatus,
    registerController,
    clearController,
    abort,
  }
}
