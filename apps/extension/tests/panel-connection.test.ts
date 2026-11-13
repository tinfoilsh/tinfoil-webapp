import { ERROR_ACTIONS, ERROR_CODES } from '@tinfoil/chat-client/protocol'
import { HarnessError } from '@tinfoil/chat-client/sse'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PANEL_RECONNECT_DELAYS_MS } from '../src/config'
import type { ToPanel, View } from '../src/messages'
import { PanelConnection } from '../src/panel-connection'

// Every byte value, which a recording is free to hold.
const RECORDING = Uint8Array.from({ length: 256 }, (_, byte) => byte)

type Sent = {
  type: string
  id?: string
  audio?: string
  mimeType?: string
}
// What the panel sent over its latest connection, and the worker's side of
// that connection.
let sent: Sent[]
let answer: (message: ToPanel) => void
let disconnect: () => void
// How many connections the panel has made.
let connections: number
// What a worker does with a connection as it is made.
let onConnect: () => void

beforeEach(() => {
  sent = []
  connections = 0
  onConnect = () => {}
  vi.stubGlobal('chrome', {
    runtime: {
      connect: () => {
        connections++
        sent = []
        const port = {
          postMessage: (message: Sent) => sent.push(message),
          disconnect: () => {},
          onMessage: {
            addListener: (listener: (message: ToPanel) => void) => {
              answer = listener
            },
          },
          onDisconnect: {
            addListener: (listener: () => void) => {
              disconnect = listener
            },
          },
        }
        queueMicrotask(() => onConnect())
        return port
      },
    },
  })
})
afterEach(() => {
  vi.useRealTimers()
})

function connected() {
  const connection = new PanelConnection('alice', async () => 'token')
  const close = connection.connect()
  return { connection, close }
}

const STATE: View = { tasks: [], verified: true }

const recording = () =>
  new File([RECORDING], 'audio.webm', { type: 'audio/webm' })

// The request to transcribe, once the recording has been read to send it.
const requested = () =>
  vi.waitFor(() => {
    const request = sent.find((message) => message.type === 'transcribe')
    if (!request?.id) throw new Error('No recording was sent')
    return { ...request, id: request.id }
  })

test('a recording reaches the worker whole and is answered with its text', async () => {
  const { connection, close } = connected()
  const text = connection.transcribe(recording())
  const request = await requested()
  expect(request.mimeType).toBe('audio/webm')
  expect(
    Uint8Array.from(atob(request.audio!), (byte) => byte.charCodeAt(0)),
  ).toEqual(RECORDING)
  answer({ type: 'transcript', id: request.id, text: 'hello there' })
  await expect(text).resolves.toBe('hello there')
  close()
})

test('what the chat service refused is refused in its own terms, and anything else as a plain failure', async () => {
  const { connection, close } = connected()
  const refused = connection.transcribe(recording()).catch((cause) => cause)
  const first = await requested()
  const detail = {
    code: ERROR_CODES.badRequest,
    action: ERROR_ACTIONS.stop,
    message: 'The recording could not be read.',
  }
  answer({
    type: 'transcript',
    id: first.id,
    error: detail.message,
    refusal: { detail, status: 400 },
  })
  const refusal = await refused
  expect(refusal).toBeInstanceOf(HarnessError)
  expect(refusal).toMatchObject({ detail, status: 400 })

  sent = []
  const failed = connection.transcribe(recording()).catch((cause) => cause)
  const second = await requested()
  answer({ type: 'transcript', id: second.id, error: 'Sign in first.' })
  const failure = await failed
  expect(failure).not.toBeInstanceOf(HarnessError)
  expect(failure).toEqual(new Error('Sign in first.'))
  close()
})

test('a recording given up on or cut off by the worker is not left waiting', async () => {
  const { connection, close } = connected()
  const giveUp = new AbortController()
  const abandoned = connection
    .transcribe(recording(), giveUp.signal)
    .catch((cause) => cause)
  const first = await requested()
  const reason = new DOMException('Timed out', 'TimeoutError')
  giveUp.abort(reason)
  expect(await abandoned).toBe(reason)
  // The worker is told to give it up too, and its late answer is dropped.
  expect(sent).toContainEqual({ type: 'cancel', id: first.id })
  answer({ type: 'transcript', id: first.id, text: 'too late' })

  sent = []
  const cutOff = connection.transcribe(recording()).catch((cause) => cause)
  await requested()
  disconnect()
  expect(await cutOff).toEqual(new Error('The extension disconnected.'))
  close()
  await expect(connection.transcribe(recording())).rejects.toThrow(
    'Reopen the panel to reconnect.',
  )
})

test('a connection the worker closed is made again, and what waited on the old one is answered', async () => {
  const { connection, close } = connected()
  expect(sent).toEqual([{ type: 'hello', owner: 'alice' }])
  answer({ type: 'state', view: STATE })
  const waiting = connection.command({ kind: 'new' }).catch((cause) => cause)
  // The browser stopped the worker.
  disconnect()
  expect(await waiting).toEqual(new Error('The extension disconnected.'))
  await vi.waitFor(() => expect(connections).toBe(2))
  expect(sent).toEqual([{ type: 'hello', owner: 'alice' }])
  expect(connection.snapshot().error).toBeUndefined()

  // The worker it started is heard as the one before was.
  const view = {
    ...STATE,
    tasks: [{ id: 'task', title: 'Kept', updatedAt: 1 }],
  }
  answer({ type: 'state', view })
  expect(connection.snapshot()).toEqual(view)
  close()
})

test('a worker that only ever closes the connection is given up on, and the panel says so', async () => {
  vi.useFakeTimers()
  onConnect = () => disconnect()
  const { connection, close } = connected()
  await vi.runAllTimersAsync()
  // The first connection, and one after each wait.
  expect(connections).toBe(PANEL_RECONNECT_DELAYS_MS.length + 1)
  expect(connection.snapshot().error).toContain('Reopen the panel')
  close()
})

test('a panel out of sight connects again only once it is looked at', async () => {
  vi.useFakeTimers()
  const { close } = connected()
  answer({ type: 'state', view: STATE })
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue('hidden')
  disconnect()
  await vi.runAllTimersAsync()
  expect(connections).toBe(1)
  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(connections).toBe(2)
  // Looking at it again later connects no second time.
  document.dispatchEvent(new Event('visibilitychange'))
  expect(connections).toBe(2)
  close()
})
