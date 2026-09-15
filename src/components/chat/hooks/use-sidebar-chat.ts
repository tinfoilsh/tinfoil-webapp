import { useHarness } from '@/services/harness/provider'
import { initialChat, reduceEvent } from '@/services/harness/reducer'
import type { Turn } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { useEffect, useRef, useState } from 'react'
import type { LoadingState, Message } from '../types'
export interface SidebarChatState {
  messages: Message[]
  quote: string | null
  loadingState: LoadingState
  isThinking: boolean
  isWaitingForResponse: boolean
  isStreaming: boolean
  retryInfo: null
}
export function useSidebarChat({
  threadId,
  options,
}: {
  threadId: string
  options: Turn['options']
}) {
  const { api } = useHarness()
  const [state, setState] = useState(initialChat)
  const [quote, setQuote] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const run = useRef<{ threadId: string; runId: string } | null>(null)
  const reset = () => {
    controller.current?.abort()
    run.current = null
    setState(initialChat())
    setQuote(null)
  }
  useEffect(() => () => controller.current?.abort(), [])
  const askQuote = (text: string) => {
    reset()
    setQuote(text)
    const abort = new AbortController()
    controller.current = abort
    void (async () => {
      try {
        const input: Turn = {
          key: api.key(),
          threadId,
          kind: 'ask',
          ephemeral: true,
          clientRequestId: crypto.randomUUID(),
          content: text,
          quote: text,
          options,
        }
        for await (const frame of api.client.events(
          '/v1/threads/turn',
          input,
          api.signal(abort.signal),
        )) {
          if (abort.signal.aborted) return
          if (frame.event.type === 'RUN_STARTED')
            run.current = {
              threadId: frame.event.threadId!,
              runId: frame.event.runId!,
            }
          setState((previous) =>
            reduceEvent(previous, frame, run.current?.runId),
          )
        }
      } catch (cause) {
        if (!abort.signal.aborted)
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: {
              code: 'CONNECTION',
              message:
                cause instanceof Error
                  ? cause.message
                  : 'Unable to open this conversation.',
            },
          }))
      }
    })()
  }
  const isStreaming = state.status === 'streaming'
  return {
    messages: state.messages.map((m, index) =>
      messageView(m, isStreaming && index === state.messages.length - 1),
    ),
    quote,
    loadingState: (isStreaming ? 'streaming' : 'idle') as LoadingState,
    isThinking: false,
    isWaitingForResponse:
      isStreaming && !state.messages.some((m) => m.role === 'assistant'),
    isStreaming,
    retryInfo: null,
    askQuote,
    reset,
    cancel: () => {
      if (run.current) void api.post('/v1/threads/cancel', run.current)
      controller.current?.abort()
    },
  }
}
