import type { HarnessClient } from '@tinfoil/chat-client/client'
import type { HarnessRoute } from '@tinfoil/chat-client/protocol'
import type {
  BrowserToolRequest,
  Frame,
  Session,
  Turn,
} from '@tinfoil/chat-client/types'
import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { client, signIn, testSession } from '../../../tests/harness-fixture'
import { storedThread } from '../../../tests/services/harness/thread-fixture'
import type { TabInfo } from '../src/browser/driver'
import { BrowserError } from '../src/browser/errors'
import { TaskController } from '../src/controller'
import type { View } from '../src/messages'
import { TaskStore } from '../src/storage'

const MODEL = 'gpt-oss-120b'
const session: Session = {
  ...testSession,
  user: { id: 'alice', anonymous: false },
  features: { ...testSession.features, browserTools: true },
  models: [{ ...testSession.models[1], id: MODEL }],
}
const close: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const finish of close.splice(0)) await finish()
})

function setup() {
  signIn({ userId: 'alice', session })
  const store = new TaskStore(crypto.randomUUID())
  const views: View[] = []
  const observers = new Set<(view: View) => void>()
  let actions = 0
  let reviewActions = false
  let workingOn!: (tab: TabInfo | undefined) => Promise<void>
  const browser = {
    execute: async () => ({ text: `Saved ${++actions}` }),
    describe: async () => 'Click Save on the selected tab',
    dispose: async () => {},
  }
  const fake = Object.assign(client, { dispose: vi.fn() })
  const controller = new TaskController(
    fake as unknown as HarnessClient,
    'alice',
    store,
    (view) => {
      views.push(structuredClone(view))
      for (const observe of observers) observe(view)
    },
    async () => reviewActions,
    (_signal, _interrupted, onTab) => {
      workingOn = onTab
      return browser
    },
  )
  const until = (test: (view: View) => boolean) =>
    new Promise<View>((resolve) => {
      const current = views.at(-1)
      if (current && test(current)) {
        resolve(current)
        return
      }
      const observe = (view: View) => {
        if (test(view)) {
          observers.delete(observe)
          resolve(view)
        }
      }
      observers.add(observe)
    })
  close.push(async () => {
    await controller.dispose()
    await store.close()
  })
  return {
    store,
    controller,
    until,
    browser,
    actions: () => actions,
    setReviewActions: (value: boolean) => {
      reviewActions = value
    },
    workingOn: (tab: TabInfo) => workingOn(tab),
  }
}

function answerPosts(
  routes: Partial<Record<HarnessRoute, (input: unknown) => unknown>>,
) {
  const fallback = client.post.getMockImplementation()!
  client.post.mockImplementation(
    async (path: HarnessRoute, input: unknown, ...rest: unknown[]) => {
      const answer = routes[path]
      return answer ? answer(input) : fallback(path, input, ...rest)
    },
  )
}

function started(turn: Turn): Frame {
  return {
    id: 0,
    event: {
      type: 'RUN_STARTED',
      threadId: turn.threadId,
      runId: 'run',
      instance: 'instance',
    },
  }
}
function ended(turn: Turn, cancelled = false): Frame {
  const thread = storedThread(turn.threadId, {
    recordVersion: 2,
    title: 'Browser task',
    model: MODEL,
    messages: [
      {
        id: 'question',
        role: 'user',
        content: turn.content!,
        createdAt: '2026-11-12T00:00:00Z',
      },
    ],
  })
  return {
    id: 3,
    event: {
      type: 'RUN_FINISHED',
      threadId: turn.threadId,
      runId: 'run',
      metadata: { thread: { ...thread, recordVersion: 2 }, cancelled },
    },
  }
}
function browserRequest(turn: Turn, executionId = 'execution'): Frame {
  const event: BrowserToolRequest = {
    type: 'BROWSER_TOOL_REQUEST',
    executorId: turn.browser!.executorId,
    executionId,
    toolCallId: 'click',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operation: { action: 'click', tabId: 1, ref: 'ref' },
  }
  return { id: 1, event }
}
const send = {
  kind: 'send' as const,
  content: 'Save the form',
  model: MODEL,
  effort: 'low' as const,
}

test('local chats return the saved harness record intact on the next turn', async () => {
  const { controller, until, store } = setup()
  const sent: Turn[] = []
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    sent.push(turn)
    yield started(turn)
    yield ended(turn)
  })
  await controller.initialize()
  await controller.command(send)
  const first = await until((view) => view.task?.phase === 'completed')
  const record = (await store.get('alice', first.task!.id))!.thread
  expect(record?.messages).toEqual([
    {
      id: 'question',
      role: 'user',
      content: 'Save the form',
      createdAt: '2026-11-12T00:00:00Z',
    },
  ])
  await controller.command({ ...send, content: 'Now explain it' })
  await until((view) => sent.length === 2 && view.task?.phase === 'completed')
  expect(sent[1]).toMatchObject({
    local: true,
    thread: record,
    content: 'Now explain it',
    options: { model: MODEL },
  })
  expect(client.post.mock.calls.map(([path]) => path)).toEqual(['/v1/session'])
})

test('browser access is automatic and the working tab is published until the run ends', async () => {
  const { controller, until, browser, workingOn } = setup()
  const tab: TabInfo = {
    id: 12,
    title: 'Current article',
    url: 'https://example.com/article',
    active: true,
  }
  let finish!: () => void
  const observed = new Promise<void>((resolve) => {
    finish = resolve
  })
  browser.execute = async () => {
    await workingOn(tab)
    await observed
    return { text: 'Article read' }
  }
  let sent!: Turn
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    sent = turn
    yield started(turn)
    yield browserRequest(turn)
    yield ended(turn)
  })
  answerPosts({
    '/v1/threads/browser/result': () => ({ accepted: true }),
  })
  await controller.initialize()
  await controller.command(send)
  const working = await until((view) => !!view.workingTab)
  expect(sent.browser?.executorId).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent.browser?.token).toMatch(/^[0-9a-f]{64}$/)
  expect(working.workingTab).toEqual(tab)
  finish()
  const done = await until(
    (view) => view.task?.phase === 'completed' && !view.workingTab,
  )
  expect(done.workingTab).toBeUndefined()
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => input),
  ).toEqual([expect.objectContaining({ result: { text: 'Article read' } })])
})

test('reconnecting after a lost browser-result acknowledgment does not click twice', async () => {
  const { controller, until, actions, store } = setup()
  let turn!: Turn
  client.events.mockImplementation(async function* (path: string, input: Turn) {
    if (path === '/v1/threads/turn') {
      turn = input
      yield started(turn)
    }
    yield browserRequest(turn)
    yield ended(turn)
  })
  let replies = 0
  answerPosts({
    '/v1/threads/browser/result': () => {
      if (++replies === 1) throw new TypeError('Lost response')
      return { accepted: true }
    },
  })
  await controller.initialize()
  await controller.command(send)
  const final = await until((view) => view.task?.phase === 'completed')
  expect(actions()).toBe(1)
  const results = client.post.mock.calls
    .filter(([path]) => path === '/v1/threads/browser/result')
    .map(([, body]) => body)
  expect(results).toHaveLength(2)
  expect(results[0]).toEqual(results[1])
  expect(results[0]).toMatchObject({
    executionId: 'execution',
    result: { text: 'Saved 1' },
  })
  expect(final.task?.error).toBeUndefined()
  expect((await store.get('alice', final.task!.id))?.thread?.title).toBe(
    'Browser task',
  )
})

test('actions run unreviewed until review is turned on, and a waiting action stays until it is decided', async () => {
  const { controller, until, actions, setReviewActions } = setup()
  let reachSecond!: () => void
  const beforeSecond = new Promise<void>((resolve) => {
    reachSecond = resolve
  })
  let turnOn!: () => void
  const reviewOn = new Promise<void>((resolve) => {
    turnOn = resolve
  })
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    yield started(turn)
    yield browserRequest(turn, 'first')
    reachSecond()
    await reviewOn
    yield browserRequest(turn, 'second')
    yield browserRequest(turn, 'third')
    yield ended(turn)
  })
  answerPosts({
    '/v1/threads/browser/result': () => ({ accepted: true }),
  })
  await controller.initialize()
  await controller.command(send)
  await beforeSecond
  expect(actions()).toBe(1)

  setReviewActions(true)
  turnOn()
  const review = await until((view) => !!view.pending)
  expect(review.pending?.executionId).toBe('second')
  expect(review.task?.phase).toBe('review')
  expect(actions()).toBe(1)

  setReviewActions(false)
  expect(actions()).toBe(1)
  await controller.command({
    kind: 'review',
    executionId: 'second',
    allow: true,
  })
  const done = await until((view) => view.task?.phase === 'completed')
  expect(done.pending).toBeUndefined()
  expect(actions()).toBe(3)
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => (input as { executionId: string }).executionId),
  ).toEqual(['first', 'second', 'third'])
})

test('stopping during review prevents execution and collects the canceled thread', async () => {
  const { controller, until, actions, store, setReviewActions } = setup()
  setReviewActions(true)
  let turn!: Turn
  client.events.mockImplementation(async function* (path: string, input: Turn) {
    if (path === '/v1/threads/follow') {
      yield ended(turn, true)
      return
    }
    turn = input
    yield started(turn)
    yield browserRequest(turn)
    throw new Error('Review should have stopped this stream')
  })
  answerPosts({
    '/v1/threads/cancel': () => ({ cancelled: true }),
  })
  await controller.initialize()
  await controller.command(send)
  const review = await until((view) => !!view.pending)
  expect(review.pending?.preview).toBe('Click Save on the selected tab')
  await controller.command({ kind: 'stop' })
  expect(actions()).toBe(0)
  const summary = (await store.list('alice'))[0]
  const saved = (await store.get('alice', summary.id))!
  expect(saved.phase).toBe('interrupted')
  expect(saved.receipt).toBeUndefined()
  expect(saved.thread?.messages[0].content).toBe('Save the form')
})

test('an expired browser operation is canceled before dispatch', async () => {
  const { controller, until, actions } = setup()
  let turn!: Turn
  client.events.mockImplementation(async function* (path: string, input: Turn) {
    if (path === '/v1/threads/follow') {
      yield ended(turn, true)
      return
    }
    turn = input
    yield started(turn)
    const frame = browserRequest(turn)
    ;(frame.event as BrowserToolRequest).expiresAt = '2020-01-01T00:00:00Z'
    yield frame
    throw new Error('An expired operation must end the stream')
  })
  answerPosts({
    '/v1/threads/cancel': () => ({ cancelled: true }),
  })
  await controller.initialize()
  await controller.command(send)
  await until((view) => view.task?.phase === 'interrupted' && !view.pending)
  expect(actions()).toBe(0)
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/cancel')
      .map(([, input]) => input),
  ).toEqual([{ threadId: turn.threadId, runId: 'run' }])
  expect(
    client.post.mock.calls.some(
      ([path]) => path === '/v1/threads/browser/result',
    ),
  ).toBe(false)
})

test('resuming repeatedly preserves the original task instead of nesting instructions', async () => {
  const { controller, until, store } = setup()
  const sent: Turn[] = []
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    sent.push(turn)
    yield started(turn)
    yield ended(turn, true)
  })
  await controller.initialize()
  await controller.command(send)
  await until((view) => sent.length === 1 && view.task?.phase === 'interrupted')
  for (const count of [2, 3]) {
    await controller.command({ kind: 'resume' })
    await until(
      (view) => sent.length === count && view.task?.phase === 'interrupted',
    )
  }
  expect(sent[1].content).toBe(sent[2].content)
  const [summary] = await store.list('alice')
  expect((await store.get('alice', summary.id))?.lastPrompt).toBe(
    'Save the form',
  )
})

test('stop cancels a send queued behind initialization', async () => {
  const { controller } = setup()
  let ready!: () => void
  const prior = new Promise<void>((resolve) => {
    ready = resolve
  })
  const initialize = controller.initialize(prior)
  const sendResult = controller.command(send).catch((error: unknown) => error)
  await controller.stop()
  ready()
  await initialize
  expect(await sendResult).toMatchObject({ name: 'AbortError' })
  expect(client.events).not.toHaveBeenCalled()
})

test('an uncertain mutation stops the run instead of becoming a retryable tool result', async () => {
  const { controller, until, browser, actions, store } = setup()
  const execute = browser.execute
  browser.execute = async () => {
    await execute()
    throw new BrowserError('COMMAND_FAILED', 'Connection lost after click')
  }
  let turn!: Turn
  client.events.mockImplementation(async function* (path: string, input: Turn) {
    if (path === '/v1/threads/follow') {
      yield ended(turn, true)
      return
    }
    turn = input
    yield started(turn)
    yield browserRequest(turn)
    throw new Error('An uncertain mutation must end the stream')
  })
  answerPosts({
    '/v1/threads/cancel': () => ({ cancelled: true }),
  })
  await controller.initialize()
  await controller.command(send)
  const final = await until((view) => view.task?.phase === 'interrupted')
  expect(actions()).toBe(1)
  expect(final.task?.error).toContain('may have completed')
  expect((await store.get('alice', final.task!.id))?.phase).toBe('interrupted')
  expect(
    client.post.mock.calls.filter(
      ([path]) => path === '/v1/threads/browser/result',
    ),
  ).toEqual([])
})
