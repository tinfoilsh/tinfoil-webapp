import type { HarnessClient } from '@tinfoil/chat-client/client'
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
  const browser = {
    attach: async () => {},
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
  return { store, controller, until, actions: () => actions }
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
function browserRequest(turn: Turn): Frame {
  const event: BrowserToolRequest = {
    type: 'BROWSER_TOOL_REQUEST',
    executorId: turn.browser!.executorId,
    executionId: 'execution',
    toolCallId: 'click',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operation: { action: 'click', tabId: 1, ref: 'ref' },
  }
  return { id: 1, event }
}
const send = {
  kind: 'send' as const,
  content: 'Save the form',
  tabs: [] as number[],
  model: MODEL,
  effort: 'low' as const,
  confirmActions: false,
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
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return session
    if (path === '/v1/threads/browser/result') {
      if (++replies === 1) throw new TypeError('Lost response')
      return { accepted: true }
    }
    throw new Error(`Unexpected path ${path}`)
  })
  await controller.initialize()
  await controller.command({ ...send, tabs: [1] })
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

test('stopping during review prevents execution and collects the canceled thread', async () => {
  const { controller, until, actions, store } = setup()
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
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return session
    if (path === '/v1/threads/cancel') return { cancelled: true }
    throw new Error(`Unexpected path ${path}`)
  })
  await controller.initialize()
  await controller.command({ ...send, tabs: [1], confirmActions: true })
  const review = await until((view) => !!view.pending)
  expect(review.pending?.preview).toBe('Click Save on the selected tab')
  await controller.command({ kind: 'stop' })
  expect(actions()).toBe(0)
  const saved = (await store.list('alice'))[0]
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
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return session
    if (path === '/v1/threads/cancel') return { cancelled: true }
    throw new Error(`Unexpected path ${path}`)
  })
  await controller.initialize()
  await controller.command({ ...send, tabs: [1] })
  await until((view) => view.task?.phase === 'interrupted' && !view.pending)
  expect(actions()).toBe(0)
  expect(
    client.post.mock.calls.some(
      ([path]) => path === '/v1/threads/browser/result',
    ),
  ).toBe(false)
})
