import type { HarnessClient } from '@tinfoil/chat-client/client'
import type { HarnessRoute } from '@tinfoil/chat-client/protocol'
import { initialChat } from '@tinfoil/chat-client/reducer'
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
import { BrowserError, outcomeUnknown } from '../src/browser/errors'
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

function setup(offered: Session = session) {
  signIn({ userId: 'alice', session: offered })
  const store = new TaskStore(crypto.randomUUID())
  const views: View[] = []
  const observers = new Set<(view: View) => void>()
  let actions = 0
  let reviewActions: boolean | Error = false
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
    async () => {
      if (reviewActions instanceof Error) throw reviewActions
      return reviewActions
    },
    () => browser,
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
    setReviewActions: (value: boolean | Error) => {
      reviewActions = value
    },
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
// Scripts a run that asks for one browser action and is stopped by it: its
// stream fails if it is read past the request, and its cancellation is
// answered and followed to the run's end. Holds the turn the run began with.
function stoppedByRequest(
  reason: string,
  prepare: (request: BrowserToolRequest) => void = () => {},
) {
  const run: { turn?: Turn } = {}
  client.events.mockImplementation(async function* (path: string, input: Turn) {
    if (path === '/v1/threads/follow') {
      yield ended(run.turn!, true)
      return
    }
    run.turn = input
    yield started(input)
    const frame = browserRequest(input)
    prepare(frame.event as BrowserToolRequest)
    yield frame
    throw new Error(reason)
  })
  answerPosts({
    '/v1/threads/cancel': () => ({ cancelled: true }),
  })
  return run
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

test('a task stored in a phase it cannot rest in opens as interrupted', async () => {
  const { controller, until, store } = setup()
  const stored = {
    id: 'task',
    owner: 'alice',
    title: 'Left paused',
    updatedAt: 1,
    state: initialChat(),
    lastPrompt: 'Save the form',
    model: MODEL,
    effort: 'low' as const,
  }
  // A phase an earlier build stored, which this one no longer has.
  await store.put({ ...stored, phase: 'paused' as never })
  await controller.initialize()
  const view = await until((view) => !!view.session)
  expect(view.task).toMatchObject({ id: 'task', phase: 'interrupted' })
  expect(view.task?.error).toContain('This task was interrupted')
  expect((await store.get('alice', 'task'))?.phase).toBe('interrupted')
})

test('every turn offers the browser to the model and answers what it asks of it', async () => {
  const { controller, until, browser } = setup()
  browser.execute = async () => ({ text: 'Article read' })
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
  await until((view) => view.task?.phase === 'completed')
  expect(sent.browser?.executorId).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent.browser?.token).toMatch(/^[0-9a-f]{64}$/)
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => input),
  ).toEqual([
    {
      threadId: sent.threadId,
      runId: 'run',
      ...sent.browser,
      executionId: 'execution',
      result: { text: 'Article read' },
    },
  ])
})

test('the picture an action takes of the page is kept with its chat, under the call it answered', async () => {
  const { controller, until, browser, store } = setup()
  const picture = btoa('the page as the task saw it')
  const answers: { text: string; image?: string }[] = [
    { text: 'Viewport', image: picture },
    { text: 'Saved' },
  ]
  browser.execute = async () => answers.shift()!
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    yield started(turn)
    const look = browserRequest(turn, 'look')
    yield { ...look, event: { ...look.event, toolCallId: 'look' } }
    yield browserRequest(turn, 'save')
    yield ended(turn)
  })
  // What this device had kept of the chat when each result reached the
  // service.
  const keptAtResult: (string | undefined)[] = []
  answerPosts({
    '/v1/threads/browser/result': async (input) => {
      const { threadId } = input as { threadId: string }
      keptAtResult.push(await store.capture('alice', threadId, 'look'))
      return { accepted: true }
    },
  })
  await controller.initialize()
  await controller.command(send)
  const done = await until((view) => view.task?.phase === 'completed')
  const id = done.task!.id
  expect(done.task?.captures).toEqual(['look'])
  expect(keptAtResult).toEqual([picture, picture])
  expect(await store.capture('alice', id, 'look')).toBe(picture)
  expect(await store.capture('alice', id, 'click')).toBeUndefined()
  expect((await store.get('alice', id))?.captures).toEqual(['look'])
  // The service is still answered with the picture.
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => (input as { result: unknown }).result),
  ).toEqual([{ text: 'Viewport', image: picture }, { text: 'Saved' }])

  await controller.command({ kind: 'delete', id })
  expect(await store.capture('alice', id, 'look')).toBeUndefined()
})

test('a picture that cannot be kept does not stop the task that took it', async () => {
  const { controller, until, browser, store } = setup()
  const picture = btoa('the page as the task saw it')
  browser.execute = async () => ({ text: 'Viewport', image: picture })
  const keep = vi
    .spyOn(store, 'putCapture')
    .mockRejectedValue(new DOMException('No room', 'QuotaExceededError'))
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    yield started(turn)
    yield browserRequest(turn)
    yield ended(turn)
  })
  answerPosts({
    '/v1/threads/browser/result': () => ({ accepted: true }),
  })
  await controller.initialize()
  await controller.command(send)
  const done = await until((view) => view.task?.phase === 'completed')
  expect(keep).toHaveBeenCalledTimes(1)
  expect(done.task?.error).toBeUndefined()
  expect(done.task?.captures).toEqual([])
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => (input as { result: unknown }).result),
  ).toEqual([{ text: 'Viewport', image: picture }])
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

test('a review setting that cannot be read stops the task before it acts', async () => {
  const { controller, until, actions, setReviewActions } = setup()
  setReviewActions(new Error('Storage unavailable'))
  const run = stoppedByRequest('An unreadable setting must end the stream')
  await controller.initialize()
  await controller.command(send)
  const final = await until((view) => view.task?.phase === 'interrupted')
  expect(final.task?.error).toContain('review setting could not be read')
  expect(final.pending).toBeUndefined()
  expect(actions()).toBe(0)
  expect(
    client.post.mock.calls.filter(
      ([path]) => path === '/v1/threads/browser/result',
    ),
  ).toEqual([])
})

test('a turn on Auto works at a level the session offers, its default when none is chosen', async () => {
  const { controller, until } = setup({
    ...session,
    models: [testSession.models[0], ...session.models],
  })
  const sent: Turn[] = []
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    sent.push(turn)
    yield started(turn)
    yield ended(turn)
  })
  const settled = (count: number) =>
    until((view) => sent.length === count && view.task?.phase === 'completed')
  await controller.initialize()
  await expect(
    controller.command({ ...send, model: 'auto', autoIntelligence: 'turbo' }),
  ).rejects.toThrow('Select an available intelligence level.')
  expect(sent).toEqual([])

  await controller.command({ ...send, model: 'auto' })
  await settled(1)
  expect(sent[0].options).toMatchObject({
    model: 'auto',
    autoIntelligence: testSession.auto.default,
  })
  await controller.command({ ...send, model: 'auto', autoIntelligence: 'low' })
  await settled(2)
  expect(sent[1].options?.autoIntelligence).toBe('low')
  // A model chosen by name works at no level of Auto's.
  await controller.command({ ...send, autoIntelligence: 'low' })
  await settled(3)
  expect(sent[2].options).not.toHaveProperty('autoIntelligence')
})

test('stopping during review prevents execution and collects the canceled thread', async () => {
  const { controller, until, actions, store, setReviewActions } = setup()
  setReviewActions(true)
  const run = stoppedByRequest('Review should have stopped this stream')
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
  const run = stoppedByRequest(
    'An expired operation must end the stream',
    (request) => {
      request.expiresAt = '2020-01-01T00:00:00Z'
    },
  )
  await controller.initialize()
  await controller.command(send)
  await until((view) => view.task?.phase === 'interrupted' && !view.pending)
  expect(actions()).toBe(0)
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/cancel')
      .map(([, input]) => input),
  ).toEqual([{ threadId: run.turn?.threadId, runId: 'run' }])
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

test('a failure before an action is delivered is answered to the model, and the run goes on', async () => {
  const { controller, until, browser } = setup()
  let attempts = 0
  browser.execute = async () => {
    if (++attempts === 1)
      throw new BrowserError('PAGE_CHANGED', 'The page navigated. Read it.')
    return { text: 'Saved on the second try' }
  }
  client.events.mockImplementation(async function* (_path: string, turn: Turn) {
    yield started(turn)
    yield browserRequest(turn, 'first')
    yield browserRequest(turn, 'second')
    yield ended(turn)
  })
  answerPosts({
    '/v1/threads/browser/result': () => ({ accepted: true }),
  })
  await controller.initialize()
  await controller.command(send)
  const final = await until((view) => view.task?.phase === 'completed')
  expect(final.task?.error).toBeUndefined()
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/browser/result')
      .map(([, input]) => (input as { result: { text: string } }).result),
  ).toEqual([
    {
      text: JSON.stringify({
        error: 'PAGE_CHANGED',
        message: 'The page navigated. Read it.',
      }),
    },
    { text: 'Saved on the second try' },
  ])
})

test('an uncertain mutation stops the run instead of becoming a retryable tool result', async () => {
  const { controller, until, browser, actions, store } = setup()
  const execute = browser.execute
  browser.execute = async () => {
    await execute()
    throw outcomeUnknown(new Error('Connection lost after click'))
  }
  const run = stoppedByRequest('An uncertain mutation must end the stream')
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
