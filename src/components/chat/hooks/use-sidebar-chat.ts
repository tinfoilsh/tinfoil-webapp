import { ROUTES } from '@/services/harness/protocol'
import { useHarness } from '@/services/harness/provider'
import { RunController } from '@/services/harness/run-controller'
import { useStore } from '@/services/harness/store'
import type { AskContext } from '@/services/harness/thread-store'
import type { Turn } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LoadingState, Message } from '../types'
const CONTEXT_UNREADABLE = 'The chat could not be read.'
export interface SidebarChatState {
  messages: Message[]
  quote: string | null
  loadingState: LoadingState
  isWaitingForResponse: boolean
  isStreaming: boolean
  retryInfo: null
}
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
  const [controller] = useState(() => new RunController(api))
  const state = useStore(controller.view)
  // The ask's question: the quoted selection, shown as a quote from the
  // moment it is asked.
  const [question, setQuestion] = useState<Message | null>(null)
  // Why the thread the ask reads could not be read, which no stream reports.
  const [contextError, setContextError] = useState<string | null>(null)
  // The ask's run, which the harness runs as a thread of its own, and the
  // key it carries.
  const asked = useRef<{ key?: string; threadId?: string; runId?: string }>({})
  controller.hooks = {
    started: (run) => Object.assign(asked.current, run),
  }
  const reset = () => {
    controller.reset()
    asked.current = {}
    setQuestion(null)
    setContextError(null)
  }
  useEffect(() => () => controller.reset(), [controller])
  const askQuote = (text: string) => {
    reset()
    setQuestion({
      role: 'user',
      content: '',
      quote: text,
      timestamp: new Date(),
    })
    controller.view.update((state) => ({ ...state, status: 'submitting' }))
    const shown = controller.track()
    void (async () => {
      let thread: AskContext
      try {
        thread = await context()
      } catch (cause) {
        if (shown()) {
          controller.view.update((state) => ({ ...state, status: 'idle' }))
          setContextError(
            cause instanceof Error ? cause.message : CONTEXT_UNREADABLE,
          )
        }
        return
      }
      if (!shown()) return
      asked.current = { key: thread.key }
      await controller.run(ROUTES.turn, {
        ...thread,
        kind: 'ask',
        ...(thread.local ? {} : { ephemeral: true }),
        clientRequestId: crypto.randomUUID(),
        content: text,
        quote: text,
        options,
      })
    })()
  }
  const isStreaming =
    state.status === 'submitting' ||
    state.status === 'streaming' ||
    state.status === 'queued'
  // A failed ask shows why as an error reply, also when it failed before the
  // harness sent any message.
  const failed =
    state.status === 'error' && state.error ? state.error.message : contextError
  const failure = useMemo<Message | null>(
    () =>
      failed
        ? {
            role: 'assistant',
            content: `Error: ${failed}`,
            timestamp: new Date(),
            isError: true,
          }
        : null,
    [failed],
  )
  return {
    messages: [
      ...(question ? [question] : []),
      // The question stands for the ask's message, which the harness returns
      // with the quote as its content.
      ...state.messages.flatMap((m, index) =>
        m.role === 'user'
          ? []
          : [
              messageView(
                m,
                isStreaming && index === state.messages.length - 1,
                state.summaries,
              ),
            ],
      ),
      ...(failure ? [failure] : []),
    ],
    quote: question?.quote ?? null,
    loadingState: (isStreaming ? 'streaming' : 'idle') as LoadingState,
    isWaitingForResponse:
      isStreaming && !state.messages.some((m) => m.role === 'assistant'),
    isStreaming,
    retryInfo: null,
    askQuote,
    reset,
    cancel: () => {
      const { key, threadId, runId } = asked.current
      if (threadId && runId)
        void controller.cancel({ key, threadId, runId }).catch(() => {})
      // The stopped stream reports nothing more, so the ask stops here and
      // keeps what it received.
      const shown = controller.view.get()
      controller.reset(
        shown.status === 'submitting' ||
          shown.status === 'streaming' ||
          shown.status === 'queued'
          ? { ...shown, status: 'idle' }
          : shown,
      )
    },
  }
}
