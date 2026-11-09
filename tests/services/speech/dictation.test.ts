import { ROUTES } from '@/services/harness/protocol'
import { HarnessError } from '@/services/harness/sse'
import { DICTATION } from '@/services/speech/constants'
import { Dictation } from '@/services/speech/dictation'
import { IndexedDBStorage } from '@/services/storage/indexed-db'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import { grantMicrophone, recording } from './fixtures'

const SEGMENT_SECONDS = 10
// Where audio cannot be analyzed the microphone reads as quiet, so a
// recording ends at its length.
const SEGMENT_MS = SEGMENT_SECONDS * 1000
const COMPOSER = Symbol('composer')
const CHAT = 'chat'

const refused = (code: string, action: string) =>
  new HarnessError({ code, action, message: code } as never, 502)

// Answers the harness's transcriptions in the order they are asked for, and
// keeps the recordings sent.
function transcriptions(answer: (call: number) => string) {
  const requests: { path: string; file: File }[] = []
  client.upload.mockImplementation(async (path: string, file: File) => {
    requests.push({ path, file })
    return { text: answer(requests.length - 1) }
  })
  return {
    sent: () =>
      Promise.all(
        requests.map(async ({ path, file }) => ({
          path,
          name: file.name,
          type: file.type,
          audio: await file.text(),
        })),
      ),
  }
}

const saved = async () =>
  (await new IndexedDBStorage().getDictationSegments()).map((segment) => ({
    index: segment.index,
    audio: segment.audio && new TextDecoder().decode(segment.audio),
    text: segment.text,
  }))

// Lets what the recorders and the harness hand over arrive.
const settle = () => vi.advanceTimersByTimeAsync(0)

function listening(dictation: Dictation, chatId = CHAT) {
  const received: string[] = []
  dictation.listen(chatId, (text) => received.push(text))
  return received
}

describe('Dictation', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    })
    signIn()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('transcribes each recording while the user keeps talking, and the composer gets the text in order', async () => {
    const { track } = grantMicrophone()
    const { sent } = transcriptions((call) => ['First part.', 'Second.'][call])
    const dictation = new Dictation(new IndexedDBStorage())
    const received = listening(dictation)

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('first part')
    await vi.advanceTimersByTimeAsync(SEGMENT_MS)
    await settle()
    expect(received).toEqual(['First part.'])
    expect(dictation.getSnapshot().status).toBe('recording')
    expect(track.stop).not.toHaveBeenCalled()

    recording().hear('second')
    dictation.stop()
    expect(dictation.getSnapshot().status).toBe('transcribing')
    await settle()
    expect(received).toEqual(['First part.', 'Second.'])
    expect(dictation.getSnapshot()).toEqual({
      status: 'idle',
      stream: null,
      retrying: 0,
      failed: 0,
    })
    expect(track.stop).toHaveBeenCalled()
    expect(await sent()).toEqual(
      ['first part', 'second'].map((audio) => ({
        path: ROUTES.transcriptions,
        name: DICTATION.FILE_NAME,
        type: DICTATION.MIME_TYPE,
        audio,
      })),
    )
    await vi.waitFor(async () => expect(await saved()).toEqual([]))
  })

  it('tries a failed recording again without holding up the composer, and keeps the text after it until it arrives', async () => {
    grantMicrophone()
    // The first recording fails once; the second is transcribed meanwhile.
    transcriptions((call) => {
      if (call === 0) throw refused('UPSTREAM_REFUSED', 'retry')
      return ['Later.', 'Earlier.'][call - 1]
    })
    const dictation = new Dictation(new IndexedDBStorage())
    const received = listening(dictation)

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('earlier')
    await vi.advanceTimersByTimeAsync(SEGMENT_MS)
    recording().hear('later')
    dictation.stop()
    await settle()
    expect(dictation.getSnapshot()).toMatchObject({
      status: 'idle',
      retrying: 1,
    })
    expect(received).toEqual([])
    await vi.waitFor(async () =>
      expect(await saved()).toEqual([
        { index: 0, audio: 'earlier', text: undefined },
        { index: 1, audio: undefined, text: 'Later.' },
      ]),
    )

    await vi.advanceTimersByTimeAsync(DICTATION.RETRY_DELAYS_MS[0])
    await settle()
    expect(received).toEqual(['Earlier.', 'Later.'])
    expect(dictation.getSnapshot()).toMatchObject({ retrying: 0, failed: 0 })
  })

  it('keeps a recording that could not be transcribed on the device, and transcribes it after a reload', async () => {
    grantMicrophone()
    let reachable = false
    const { sent } = transcriptions(() => {
      if (!reachable) throw new TypeError('Failed to fetch')
      return 'Kept.'
    })
    const dictation = new Dictation(new IndexedDBStorage())
    const received = listening(dictation)

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('kept')
    dictation.stop()
    await vi.advanceTimersByTimeAsync(
      DICTATION.RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0),
    )
    expect(dictation.getSnapshot()).toMatchObject({ retrying: 0, failed: 1 })
    expect(await sent()).toHaveLength(DICTATION.RETRY_DELAYS_MS.length + 1)
    expect(received).toEqual([])
    await vi.waitFor(async () =>
      expect(await saved()).toEqual([
        { index: 0, audio: 'kept', text: undefined },
      ]),
    )

    // The page is opened again once the harness can be reached.
    reachable = true
    const reloaded = new Dictation(new IndexedDBStorage())
    const afterReload = listening(reloaded)
    await vi.waitFor(() => expect(afterReload).toEqual(['Kept.']))
    await vi.waitFor(async () => expect(await saved()).toEqual([]))
  })

  it('holds a recording the harness refuses for the user, who can try it again or discard it', async () => {
    grantMicrophone()
    // Neither recording is taken at first. Tried again, the first is
    // refused again and the second is taken.
    transcriptions((call) => {
      if (call < 3) throw refused('ATTACHMENT_UNSUPPORTED', 'revise')
      return 'Second.'
    })
    const dictation = new Dictation(new IndexedDBStorage())
    const received = listening(dictation)

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('first')
    await vi.advanceTimersByTimeAsync(SEGMENT_MS)
    recording().hear('second')
    dictation.stop()
    await settle()
    expect(dictation.getSnapshot()).toMatchObject({ status: 'idle', failed: 2 })
    expect(received).toEqual([])

    dictation.retry()
    await settle()
    // The first is refused again; the second waits behind it.
    expect(dictation.getSnapshot()).toMatchObject({ failed: 1 })
    expect(received).toEqual([])

    dictation.discard()
    expect(received).toEqual(['Second.'])
    expect(dictation.getSnapshot()).toMatchObject({ failed: 0, retrying: 0 })
    await vi.waitFor(async () => expect(await saved()).toEqual([]))
  })

  it('keeps a chat’s dictated text for that chat’s composer, also after a reload', async () => {
    grantMicrophone()
    transcriptions(() => 'Mine.')
    const dictation = new Dictation(new IndexedDBStorage())
    const inChat: string[] = []
    const leaveChat = dictation.listen(CHAT, (text) => inChat.push(text))

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('mine')
    dictation.stop()
    // The user moves to another chat before the text arrives.
    leaveChat()
    const inAnotherChat = listening(dictation, 'another chat')
    await settle()
    expect(dictation.getSnapshot()).toMatchObject({ status: 'idle' })
    expect(inChat).toEqual([])
    expect(inAnotherChat).toEqual([])
    await vi.waitFor(async () =>
      expect(await saved()).toEqual([
        { index: 0, audio: undefined, text: 'Mine.' },
      ]),
    )

    const reloaded = new Dictation(new IndexedDBStorage())
    const elsewhereAfterReload = listening(reloaded, 'another chat')
    const backInChat = listening(reloaded)
    await vi.waitFor(() => expect(backInChat).toEqual(['Mine.']))
    expect(elsewhereAfterReload).toEqual([])
    await vi.waitFor(async () => expect(await saved()).toEqual([]))
  })

  it('never writes a temporary chat’s dictation to the device', async () => {
    grantMicrophone()
    transcriptions(() => {
      throw refused('ATTACHMENT_UNSUPPORTED', 'revise')
    })
    const dictation = new Dictation(new IndexedDBStorage())
    listening(dictation)

    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: false,
    })
    recording().hear('private')
    dictation.stop()
    await settle()
    expect(dictation.getSnapshot()).toMatchObject({ failed: 1 })
    // A dictation in a saved chat after it is kept, and it alone.
    await dictation.start({
      owner: COMPOSER,
      chatId: CHAT,
      segmentSeconds: SEGMENT_SECONDS,
      persist: true,
    })
    recording().hear('kept')
    dictation.stop()
    await vi.waitFor(async () => expect(await saved()).not.toEqual([]))
    expect(await saved()).toEqual([
      { index: 0, audio: 'kept', text: undefined },
    ])
  })
})
