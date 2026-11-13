import { ERROR_ACTIONS, ERROR_CODES } from '@tinfoil/chat-client/protocol'
import { HarnessError } from '@tinfoil/chat-client/sse'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ToPanel } from '../src/messages'
import { PanelConnection } from '../src/panel-connection'

// Every byte value, which a recording is free to hold.
const RECORDING = Uint8Array.from({ length: 256 }, (_, byte) => byte)

type Sent = { type: string; id: string; audio?: string; mimeType?: string }
let sent: Sent[]
let answer: (message: ToPanel) => void
let disconnect: () => void

beforeEach(() => {
  sent = []
  vi.stubGlobal('chrome', {
    runtime: {
      connect: () => ({
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
      }),
    },
  })
})

function connected() {
  const connection = new PanelConnection('alice', async () => 'token')
  const close = connection.connect()
  return { connection, close }
}

const recording = () =>
  new File([RECORDING], 'audio.webm', { type: 'audio/webm' })

// The request to transcribe, once the recording has been read to send it.
const requested = () =>
  vi.waitFor(() => {
    const request = sent.find((message) => message.type === 'transcribe')
    if (!request) throw new Error('No recording was sent')
    return request
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
  // Its late answer is dropped.
  answer({ type: 'transcript', id: first.id, text: 'too late' })

  sent = []
  const cutOff = connection.transcribe(recording()).catch((cause) => cause)
  await requested()
  disconnect()
  expect(await cutOff).toEqual(new Error('The extension disconnected.'))
  await expect(connection.transcribe(recording())).rejects.toThrow(
    'Reopen the panel to reconnect.',
  )
  close()
})
