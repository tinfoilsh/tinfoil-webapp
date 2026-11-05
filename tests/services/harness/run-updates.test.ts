import { ROUTES } from '@/services/harness/protocol'
import { initialChat, type ChatState } from '@/services/harness/reducer'
import {
  RunController,
  YIELD_AFTER_MS,
} from '@/services/harness/run-controller'
import { HarnessError } from '@/services/harness/sse'
import { HIDDEN_PUBLISH_MS, SLOW_RENDER_MS } from '@/services/harness/store'
import type { Frame, Message } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, fakeTimeouts, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from './thread-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

resetChatStoresAroundEachTest()

// The animation frames the page asked for, which run when a test draws one.
let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  frames = new Map()
  let requested = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++requested, callback)
    return requested
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

// Draws the next animation frame, running the callbacks asked for before it.
function draw() {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(performance.now())
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

const RUN = { threadId: 'thread-1', runId: 'run-1' }
const question: Message = {
  id: 'u1',
  role: 'user',
  createdAt: '2026-10-01T00:00:00Z',
  content: 'Why?',
}
const started: Frame['event'] = {
  type: 'RUN_STARTED',
  ...RUN,
  instance: 'instance-1',
}
const window: Frame['event'] = {
  type: 'MESSAGES_SNAPSHOT',
  messages: [question],
  hasOlder: false,
}
const chunk = (delta: string): Frame['event'] => ({
  type: 'TEXT_MESSAGE_CHUNK',
  messageId: 'a1',
  role: 'assistant',
  delta,
})
const finished: Frame['event'] = {
  type: 'RUN_FINISHED',
  ...RUN,
  metadata: {},
}
// The reply the chunks streamed, as the chat holds it.
const reply = (text: string): Message => ({
  id: 'a1',
  role: 'assistant',
  createdAt: '',
  timeline: [{ id: 'a1_content_0', type: 'content', content: text }],
})

// Streams the events of each batch back to back, as one chunk of the
// stream carries them, and waits for `between` before the next batch.
function stream(batches: Frame['event'][][], between: (() => Promise<void>)[]) {
  client.events.mockImplementation(async function* () {
    let id = 0
    for (const [index, batch] of batches.entries()) {
      for (const event of batch) yield { id: id++, event }
      await between[index]?.()
    }
  })
}

// A controller of a chat's runs, and every state it showed, in order.
function watched() {
  const controller = new RunController(signIn())
  const shown: ChatState[] = []
  controller.view.subscribe(() => shown.push(controller.view.shown()))
  return { controller, shown }
}

describe('a run that streams faster than the page draws', () => {
  it('shows the frames each chunk applied once per animation frame', async () => {
    const { controller, shown } = watched()
    const first = gate()
    const second = gate()
    const more = gate()
    const end = gate()
    stream(
      [
        [started, window, chunk('Hel'), chunk('lo')],
        [chunk(','), chunk(' world')],
        [finished],
      ],
      [
        async () => {
          first.open()
          await more.opened
        },
        async () => {
          second.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)

    await first.opened
    // The run's start shows at once; what it streamed waits for a frame,
    // while the chat's code reads it already.
    expect(shown.map(({ status }) => status)).toEqual(['streaming'])
    expect(shown[0].messages).toEqual([])
    expect(controller.view.get().messages).toEqual([question, reply('Hello')])
    expect(frames.size).toBe(1)
    draw()
    expect(shown).toHaveLength(2)
    expect(shown[1]).toBe(controller.view.get())
    expect(shown[1].messages).toEqual([question, reply('Hello')])

    more.open()
    await second.opened
    expect(shown).toHaveLength(2)
    expect(frames.size).toBe(1)
    draw()
    expect(shown).toHaveLength(3)
    expect(shown[2].messages).toEqual([question, reply('Hello, world')])

    end.open()
    await running
    expect(shown.map(({ status }) => status)).toEqual([
      'streaming',
      'streaming',
      'streaming',
      'idle',
    ])
  })

  it('shows its end at once, with everything it streamed before', async () => {
    const { controller, shown } = watched()
    stream([[started, window, chunk('Hel'), chunk('lo'), finished]], [])

    expect(await controller.run(ROUTES.follow, RUN)).toBe(true)

    expect(shown.map(({ status }) => status)).toEqual(['streaming', 'idle'])
    expect(shown[1].messages).toEqual([question, reply('Hello')])
    // The frame the streamed text waited for is no longer needed.
    expect(frames.size).toBe(0)
  })

  it('shows at once why a turn queued behind it failed', async () => {
    const { controller, shown } = watched()
    const reached = gate()
    const end = gate()
    const refusal = {
      code: 'RATE_LIMITED',
      action: 'retry',
      message: 'You reached the hourly limit',
    } as const
    stream(
      [
        [
          started,
          window,
          chunk('Hello'),
          {
            type: 'RUN_ERROR',
            threadId: RUN.threadId,
            runId: 'run-2',
            ...refusal,
          },
        ],
        [finished],
      ],
      [
        async () => {
          reached.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)
    await reached.opened

    expect(shown).toHaveLength(2)
    expect(shown[1]).toMatchObject({
      messages: [question, reply('Hello')],
      status: 'streaming',
      error: refusal,
    })
    expect(frames.size).toBe(0)
    end.open()
    await running
  })

  it('shows what it streamed with the error that ends it', async () => {
    const { controller, shown } = watched()
    const refusal = {
      code: 'INVALID_STREAM',
      action: 'stop',
      message: 'The chat stream contained an invalid event.',
    } as const
    client.events.mockImplementation(async function* () {
      const events = [started, window, chunk('Hel'), chunk('lo')]
      for (const [id, event] of events.entries()) yield { id, event }
      throw new HarnessError(refusal)
    })

    expect(await controller.run(ROUTES.follow, RUN)).toBe(false)

    expect(shown).toHaveLength(2)
    expect(shown[1]).toMatchObject({
      messages: [question, reply('Hello')],
      status: 'error',
      error: refusal,
    })
    expect(frames.size).toBe(0)
  })

  it('drops the frame of a chat the view moved away from', async () => {
    const { controller, shown } = watched()
    const reached = gate()
    const end = gate()
    stream(
      [[started, window, chunk('Hello')], [finished]],
      [
        async () => {
          reached.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)
    await reached.opened
    expect(frames.size).toBe(1)

    const next = initialChat()
    controller.reset(next)

    expect(frames.size).toBe(0)
    expect(shown.at(-1)).toBe(next)
    end.open()
    expect(await running).toBe(false)
    expect(shown.at(-1)).toBe(next)
  })

  it('shows the reply it streamed as the user stops it', async () => {
    signIn()
    const reached = gate()
    const end = gate()
    client.events.mockImplementation(async function* (_path, input) {
      const threadId = input.threadId as string
      const events: Frame['event'][] = [
        { ...started, threadId },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ ...question, id: input.clientRequestId as string }],
          hasOlder: false,
        },
        chunk('Hel'),
        chunk('lo'),
      ]
      for (const [id, event] of events.entries()) yield { id, event }
      reached.open()
      await end.opened
      yield {
        id: events.length,
        event: { ...finished, threadId, metadata: { cancelled: true } },
      }
    })
    const answer = client.post.getMockImplementation()!
    client.post.mockImplementation(async (path: string, ...rest: unknown[]) =>
      path === ROUTES.cancel ? {} : answer(path, ...rest),
    )
    const { result } = renderHook(() => useThread())
    let sending!: Promise<unknown>
    act(() => {
      sending = Promise.resolve(result.current.send({ content: 'Why?' }))
    })
    await act(() => reached.opened)
    expect(result.current.chat.messages.map(({ content }) => content)).toEqual([
      'Why?',
    ])
    expect(frames.size).toBe(1)

    await act(() => result.current.cancel())

    expect(result.current.stopping).toBe(true)
    expect(result.current.chat.messages.map(({ content }) => content)).toEqual([
      'Why?',
      'Hello',
    ])
    expect(frames.size).toBe(0)
    end.open()
    await act(() => sending)
  })
})

describe('a run of a hidden page', () => {
  it('shows what it streams on a timer, since a hidden page draws no frames', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fakeTimeouts()
    const { controller, shown } = watched()
    const reached = gate()
    const end = gate()
    stream(
      [[started, window, chunk('Hello')], [finished]],
      [
        async () => {
          reached.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)
    await reached.opened
    expect(frames.size).toBe(0)
    expect(shown).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(HIDDEN_PUBLISH_MS - 1)
    expect(shown).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(shown).toHaveLength(2)
    expect(shown[1].messages).toEqual([question, reply('Hello')])

    end.open()
    await running
  })

  it('shows what waited for a frame as soon as the page is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    const { controller, shown } = watched()
    const reached = gate()
    const end = gate()
    stream(
      [[started, window, chunk('Hello')], [finished]],
      [
        async () => {
          reached.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)
    await reached.opened
    expect(frames.size).toBe(1)
    expect(shown).toHaveLength(1)

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(shown).toHaveLength(2)
    expect(shown[1].messages).toEqual([question, reply('Hello')])
    expect(frames.size).toBe(0)
    end.open()
    await running
  })
})

describe('a run on a slow device', () => {
  it('leaves the page as long without a render as its last render took', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const render = 4 * SLOW_RENDER_MS
    const { controller, shown } = watched()
    // Each state shown takes as long to render.
    controller.view.subscribe(() => {
      now += render
    })
    const reached = gate()
    const end = gate()
    stream(
      [[started, window, chunk('Hello')], [finished]],
      [
        async () => {
          reached.open()
          await end.opened
        },
      ],
    )
    const running = controller.run(ROUTES.follow, RUN)
    await reached.opened
    expect(shown).toHaveLength(1)

    // The run's start rendered from 0 to `render`.
    draw()
    expect(shown).toHaveLength(1)
    now = 2 * render - 1
    draw()
    expect(shown).toHaveLength(1)
    now = 2 * render
    draw()
    expect(shown).toHaveLength(2)
    expect(shown[1].messages).toEqual([question, reply('Hello')])

    end.open()
    await running
  })

  it('lets the browser draw and answer input while it applies a long backlog', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const turn = gate()
    const browserTurn = vi.fn(() => turn.opened)
    vi.stubGlobal('scheduler', { yield: browserTurn })
    const { controller } = watched()
    const reached = gate()
    const end = gate()
    client.events.mockImplementation(async function* () {
      const events = [started, window, chunk('a')]
      for (const [id, event] of events.entries()) yield { id, event }
      // Applying the frames so far held the page this long.
      now = YIELD_AFTER_MS
      yield { id: 3, event: chunk('b') }
      yield { id: 4, event: chunk('c') }
      reached.open()
      await end.opened
      yield { id: 5, event: finished }
    })
    const running = controller.run(ROUTES.follow, RUN)

    await vi.waitFor(() => expect(browserTurn).toHaveBeenCalledOnce())
    expect(controller.view.get().messages).toEqual([question, reply('a')])

    turn.open()
    await reached.opened
    expect(controller.view.get().messages).toEqual([question, reply('abc')])
    expect(browserTurn).toHaveBeenCalledOnce()

    end.open()
    await running
  })
})
