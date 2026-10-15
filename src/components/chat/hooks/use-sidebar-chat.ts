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
type AskContext = Pick<
  Turn,
  'key' | 'threadId' | 'local' | 'thread' | 'profile'
>
export function useSidebarChat({
  context,
  options,
}: {
  // The thread an ask reads: a stored thread by id and key, or a local
  // thread's transcript.
  context: () => Promise<AskContext>
  options: Turn['options']
}) {
  const { api } = useHarness()
  const [state, setState] = useState(initialChat)
  const [quote, setQuote] = useState<string | null>(null)
  // A local ask's run starts from the whole transcript; only the quote and
  // its answer belong in the sidebar.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const controller = useRef<AbortController | null>(null)
  const run = useRef<{ threadId: string; runId: string } | null>(null)
  const local = useRef(false)
  const reset = () => {
    controller.current?.abort()
    run.current = null
    setState(initialChat())
    setQuote(null)
    setHidden(new Set())
  }
  useEffect(() => () => controller.current?.abort(), [])
  const askQuote = (text: string) => {
    reset()
    setQuote(text)
    const abort = new AbortController()
    controller.current = abort
    void (async () => {
      try {
        const thread = await context()
        if (abort.signal.aborted) return
        local.current = !!thread.local
        setHidden(
          new Set(thread.thread?.messages.map((message) => message.id) ?? []),
        )
        const input: Turn = {
          ...thread,
          kind: 'ask',
          ...(thread.local ? {} : { ephemeral: true }),
          clientRequestId: crypto.randomUUID(),
          content: text,
          quote: text,
          options,
        }
        for await (const frame of api.client.events(
          '/v1/threads/turn',
          input,
          api.signal(abort.signal, !thread.local),
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
  const shown = state.messages.filter((message) => !hidden.has(message.id))
  return {
    messages: shown.map((m, index) =>
      messageView(m, isStreaming && index === shown.length - 1),
    ),
    quote,
    loadingState: (isStreaming ? 'streaming' : 'idle') as LoadingState,
    isThinking: false,
    isWaitingForResponse:
      isStreaming && !shown.some((m) => m.role === 'assistant'),
    isStreaming,
    retryInfo: null,
    askQuote,
    reset,
    cancel: () => {
      if (run.current)
        void api.post(
          '/v1/threads/cancel',
          run.current,
          undefined,
          !local.current,
        )
      controller.current?.abort()
    },
  }
}
