import { ROUTES } from '@/services/harness/protocol'
import { useHarness } from '@/services/harness/provider'
import { RunController } from '@/services/harness/run-controller'
import { useStore } from '@/services/harness/store'
import type { AskContext } from '@/services/harness/thread-store'
import type { Turn } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LoadingState, Message } from '../types'
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
  const [quote, setQuote] = useState<string | null>(null)
  // The ask's run, which the harness runs as a thread of its own, and the
  // key it carries.
  const asked = useRef<{ key?: string; threadId?: string; runId?: string }>({})
  controller.hooks = {
    started: (run) => Object.assign(asked.current, run),
  }
  const reset = () => {
    controller.reset()
    asked.current = {}
    setQuote(null)
  }
  useEffect(() => () => controller.reset(), [controller])
  const askQuote = (text: string) => {
    reset()
    setQuote(text)
    const shown = controller.track()
    void (async () => {
      let thread: AskContext
      try {
        thread = await context()
      } catch (cause) {
        if (shown()) controller.fail(cause)
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
  const isStreaming = state.status === 'streaming'
  // A failed ask shows why as an error reply, also when it failed before the
  // harness sent any message.
  const failure = useMemo<Message | null>(
    () =>
      state.status === 'error' && state.error
        ? {
            role: 'assistant',
            content: `Error: ${state.error.message}`,
            timestamp: new Date(),
            isError: true,
          }
        : null,
    [state.status, state.error],
  )
  return {
    messages: [
      ...state.messages.map((m, index) =>
        messageView(
          m,
          isStreaming && index === state.messages.length - 1,
          state.summaries,
        ),
      ),
      ...(failure ? [failure] : []),
    ],
    quote,
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
        shown.status === 'streaming' || shown.status === 'queued'
          ? { ...shown, status: 'idle' }
          : shown,
      )
    },
  }
}
