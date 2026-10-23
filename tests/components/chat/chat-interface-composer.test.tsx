import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { Toaster } from '@/components/ui/toaster'
import {
  UI_SIDEBAR_OPEN,
  USER_PREFS_LOCAL_PROFILE,
} from '@/constants/storage-keys'
import { localThreadStore } from '@/services/harness/local-threads'
import { publish } from '@/services/harness/runtime'
import type { Frame, Turn } from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => ({
  ...(await import('./chat-page-mocks')).clerk,
  useReverification: (callback: unknown) => callback,
}))
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => {
  const { lazy, Suspense } = await import('react')
  return {
    default: (
      load: () => Promise<React.ComponentType<Record<string, unknown>>>,
    ) => {
      const Component = lazy(async () => ({ default: await load() }))
      return function Loaded(props: Record<string, unknown>) {
        return (
          <Suspense fallback={null}>
            <Component {...props} />
          </Suspense>
        )
      }
    },
  }
})
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

resetChatStoresAroundEachTest()
beforeEach(() => {
  const setAttribute = HTMLIFrameElement.prototype.setAttribute
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(
    function (this: HTMLIFrameElement, name, value) {
      if (name !== 'src') setAttribute.call(this, name, value)
    },
  )
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
    null,
  )
  vi.stubGlobal('innerWidth', 1440)
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  chatPage.router.push.mockReset().mockResolvedValue(true)
  refuseFetch()
})

function view(localChatId?: string) {
  return (
    <ProjectProvider>
      <ChatInterface
        initialChatId={localChatId}
        isLocalChatUrl={!!localChatId}
        suppressIntroModals
      />
    </ProjectProvider>
  )
}

// Each turn's run answers and finishes at once.
function answerTurns() {
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', runId: 'reply', threadId: input.threadId! },
    }
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: 'The answer is here.',
      },
    }
    yield {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        runId: 'reply',
        threadId: input.threadId!,
      },
    }
  })
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// The harness's answers for a chat stored with cloud sync.
function answerCloudRequests() {
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/cancel') return { cancelled: true }
    throw new Error(`Unexpected ${path}`)
  })
}

const sentTurns = () =>
  client.events.mock.calls.map(([, input]) => input as Turn)

async function send(text: string) {
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

function openInputOptions() {
  fireEvent.click(screen.getByRole('button', { name: 'Input options' }))
  return screen.getByRole('menu', { name: 'Input options' })
}

const turnOptions = (webSearch: boolean) => ({
  model: testSession.defaultModel,
  autoIntelligence: testSession.auto!.default,
  reasoningEffort: 'medium',
  thinking: true,
  webSearch,
  piiCheck: true,
  genUI: true,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})

it('hides the web search control and sends turns without search once Settings turns it off', async () => {
  // The default prompt turns web search on, which Settings overrides.
  const profile = {
    customPromptPresets: [
      {
        id: 'user:researcher',
        name: 'Researcher',
        description: '',
        systemPrompt: 'Cite sources.',
        webSearchEnabled: true,
      },
    ],
    defaultPromptPresetId: 'user:researcher',
  }
  localStorage.setItem(USER_PREFS_LOCAL_PROFILE, JSON.stringify(profile))
  signIn({ profile })
  answerTurns()
  render(view())
  await screen.findByRole('textbox', { name: 'Message' })
  expect(
    within(openInputOptions()).getByRole('menuitemcheckbox', {
      name: 'Web search',
    }),
  ).toHaveAttribute('aria-checked', 'true')
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Input options' }), {
    key: 'Escape',
  })

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const settings = await screen.findByRole('dialog', { name: 'Settings' })
  fireEvent.click(
    within(settings).getAllByRole('button', { name: 'Chat Settings' })[0],
  )
  expect(within(settings).getByText('Automatic PII Blocking')).toBeVisible()
  const available = within(settings).getByRole('checkbox', {
    name: 'Web Search',
  })
  expect(available).toBeChecked()
  fireEvent.click(available)

  await waitFor(() => expect(available).not.toBeChecked())
  expect(
    within(settings).queryByText('Automatic PII Blocking'),
  ).not.toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!)).toEqual({
    ...profile,
    webSearchAvailable: false,
  })
  fireEvent.click(
    within(settings).getAllByRole('button', { name: 'Close settings' })[0],
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Settings' }),
    ).not.toBeInTheDocument(),
  )
  expect(
    within(openInputOptions()).queryByRole('menuitemcheckbox', {
      name: 'Web search',
    }),
  ).not.toBeInTheDocument()

  await send('What happened today?')
  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(sentTurns()[0].options).toEqual(turnOptions(false))
})

it('turns web search off for the open chat only, so a new chat searches again', async () => {
  signIn()
  answerTurns()
  render(view())
  await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.click(
    within(openInputOptions()).getByRole('menuitemcheckbox', {
      name: 'Web search',
    }),
  )
  expect(
    within(openInputOptions()).getByRole('menuitemcheckbox', {
      name: 'Web search',
    }),
  ).toHaveAttribute('aria-checked', 'false')
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Input options' }), {
    key: 'Escape',
  })
  expect(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)).toBeNull()

  await send('Answer from what you know')
  expect(
    await screen.findByRole('article', { name: 'Al said' }),
  ).toHaveTextContent('The answer is here.')
  expect(sentTurns()[0].options).toEqual(turnOptions(false))

  fireEvent.click(screen.getAllByRole('link', { name: 'New chat' })[0])
  await waitFor(() =>
    expect(
      screen.queryByRole('article', { name: 'You said' }),
    ).not.toBeInTheDocument(),
  )
  expect(
    within(openInputOptions()).getByRole('menuitemcheckbox', {
      name: 'Web search',
    }),
  ).toHaveAttribute('aria-checked', 'true')
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Input options' }), {
    key: 'Escape',
  })
  await send('Search for the news')
  await waitFor(() => expect(sentTurns()).toHaveLength(2))
  expect(sentTurns()[1].options).toEqual(turnOptions(true))
  expect(sentTurns()[1].threadId).not.toBe(sentTurns()[0].threadId)
})

it('stops a streaming reply when Escape is pressed in the composer', async () => {
  signIn({ cloud: true })
  answerCloudRequests()
  const finished = gate()
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', runId: 'reply', threadId: input.threadId! },
    }
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: 'Once upon a time',
      },
    }
    await finished.promise
    yield {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        runId: 'reply',
        threadId: input.threadId!,
      },
    }
  })
  render(view())
  await send('Write a long story')
  expect(
    await screen.findByRole('article', { name: 'Al said' }),
  ).toHaveTextContent('Once upon a time')
  expect(client.post).not.toHaveBeenCalledWith(
    '/v1/threads/cancel',
    expect.anything(),
    expect.anything(),
  )

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
    key: 'Escape',
  })

  await waitFor(() =>
    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/cancel',
      { key: KEY, threadId: sentTurns()[0].threadId, runId: 'reply' },
      expect.any(AbortSignal),
    ),
  )
  await act(async () => finished.resolve())
})

it('sends the finished attachments and keeps one still uploading for the next message', async () => {
  signIn()
  answerTurns()
  const descriptor = (fileName: string, mimeType: string) => ({
    id: `att-${fileName}`,
    kind: 'document',
    fileName,
    mimeType,
    size: 4,
  })
  const notes = descriptor('notes.txt', 'text/plain')
  const report = descriptor('report.pdf', 'application/pdf')
  const reportUploaded = gate()
  client.upload.mockImplementation(async (_path: string, file: File) => {
    if (file.name === report.fileName) await reportUploaded.promise
    return { attachment: file.name === notes.fileName ? notes : report }
  })
  render(view())
  await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: {
      files: [
        new File(['note'], notes.fileName),
        new File(['%PDF'], report.fileName),
      ],
    },
  })
  await screen.findByText('Document')
  expect(
    screen.getByRole('button', { name: 'Remove report.pdf' }),
  ).toBeInTheDocument()
  expect(screen.getAllByText('Document')).toHaveLength(1)

  await send('Summarize these')

  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(sentTurns()[0].content).toBe('Summarize these')
  expect(sentTurns()[0].attachments).toEqual([notes])
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  expect(
    screen.queryByRole('button', { name: 'Remove notes.txt' }),
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Remove report.pdf' }),
  ).toBeInTheDocument()

  await act(async () => reportUploaded.resolve())
  expect(
    within(
      screen.getByRole('button', { name: 'Remove report.pdf' }).parentElement!,
    ).getByText('Document'),
  ).toBeInTheDocument()
})

it('asks a free account out of daily requests to subscribe once per exhaustion, keeping what it typed', async () => {
  signIn()
  answerTurns()
  publish({ rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 0 } })
  render(view())
  const composer = await screen.findByRole('textbox', { name: 'Message' })
  const prompt = () =>
    screen.queryByRole('dialog', { name: 'No more free requests' })
  const dismiss = async () => {
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
  }

  fireEvent.blur(composer)
  fireEvent.focus(composer)
  expect(
    await screen.findByRole('dialog', { name: 'No more free requests' }),
  ).toBeVisible()
  await dismiss()
  fireEvent.blur(composer)
  fireEvent.focus(composer)
  expect(prompt()).not.toBeInTheDocument()
  await send('Keep this question')
  expect(
    await screen.findByRole('dialog', { name: 'No more free requests' }),
  ).toBeVisible()
  await dismiss()
  expect(composer).toHaveValue('Keep this question')
  expect(client.events).not.toHaveBeenCalled()

  act(() =>
    publish({
      rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 3 },
    }),
  )
  act(() =>
    publish({
      rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 0 },
    }),
  )
  fireEvent.blur(composer)
  fireEvent.focus(composer)
  expect(
    await screen.findByRole('dialog', { name: 'No more free requests' }),
  ).toBeVisible()
  await dismiss()

  act(() =>
    publish({
      rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 3 },
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(sentTurns()[0].content).toBe('Keep this question')
  expect(prompt()).not.toBeInTheDocument()
})

it('does not ask a subscriber at the hourly cap to subscribe', async () => {
  signIn()
  answerTurns()
  publish({ rateLimit: { kind: 'hourly', maxRequests: 10, remaining: 0 } })
  render(view())
  const composer = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.blur(composer)
  fireEvent.focus(composer)
  await send('Hourly question')
  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(
    screen.queryByRole('dialog', { name: 'No more free requests' }),
  ).not.toBeInTheDocument()
})

it('asks a free account out of daily requests to subscribe instead of regenerating a reply', async () => {
  signIn()
  answerTurns()
  await localThreadStore('device').add(
    storedThread('saved-chat', {
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'A saved question',
          createdAt: '2026-10-22T12:00:00Z',
        },
        {
          id: 'reply',
          role: 'assistant',
          content: 'A saved reply',
          createdAt: '2026-10-22T12:00:01Z',
        },
      ],
    }),
  )
  publish({ rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 0 } })
  render(view('saved-chat'))
  await screen.findByText('A saved reply')

  fireEvent.click(
    screen.getAllByRole('button', { name: 'Regenerate response' })[0],
  )

  expect(
    await screen.findByRole('dialog', { name: 'No more free requests' }),
  ).toBeVisible()
  expect(client.events).not.toHaveBeenCalled()
})

it('explains a send the locked key refused on the welcome screen and offers to unlock it', async () => {
  signIn({ cloud: true, locked: true })
  answerCloudRequests()
  render(view())

  await send('A question for later')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Your encryption key is locked')
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'A question for later',
  )
  expect(client.events).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(within(alert).getByRole('button', { name: 'Unlock' }))
  expect(await screen.findByRole('dialog')).toBeVisible()
})

it('shows the attachments and quote of each queued message', async () => {
  signIn({ cloud: true })
  const saved = {
    ...storedThread('busy-chat', {
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'A first question',
          createdAt: '2026-10-22T12:00:00Z',
        },
      ],
      activeRun: { runId: 'run-1', expiresAt: '2026-10-22T13:00:00Z' },
    }),
    messageCount: 1,
    hasOlder: false,
  }
  const { messages: _messages, hasOlder: _hasOlder, ...summary } = saved
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(saved)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  const held = gate()
  client.events.mockImplementation(async function* (): AsyncGenerator<Frame> {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: saved.id, runId: 'run-1' },
    }
    yield {
      id: 1,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: summary,
          queue: [
            {
              queueId: 'queued-files',
              content: '',
              attachments: [
                {
                  id: 'att-door',
                  kind: 'image',
                  fileName: 'door.png',
                  mimeType: 'image/png',
                  size: 4,
                  thumbnail: 'dGh1bWI=',
                },
                {
                  id: 'att-notes',
                  kind: 'document',
                  fileName: 'notes.txt',
                  mimeType: 'text/plain',
                  size: 4,
                },
              ],
            },
            { queueId: 'queued-quote', content: null, quote: 'Earlier text' },
            { queueId: 'queued-text', content: 'And then?' },
          ],
        },
      },
    }
    await held.promise
  })
  render(
    <ProjectProvider>
      <ChatInterface initialChatId={saved.id} suppressIntroModals />
    </ProjectProvider>,
  )

  expect(await screen.findByText('And then?')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'door.png' })).toHaveAttribute(
    'src',
    'data:image/png;base64,dGh1bWI=',
  )
  expect(screen.getByText('2 attachments')).toBeInTheDocument()
  expect(screen.getByText('Quoted reply')).toBeInTheDocument()
  expect(
    screen.getAllByRole('button', { name: 'Remove queued message' }),
  ).toHaveLength(3)
  held.resolve()
})

const otherModel = {
  ...testSession.models[1],
  id: 'other-model',
  label: 'Other model',
  shortLabel: 'Other',
}
const sessionWithOtherModel = {
  ...testSession,
  models: [...testSession.models, otherModel],
}
const savedChat = (model: string) =>
  storedThread('saved-chat', {
    model,
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'A saved question',
        createdAt: '2026-10-22T12:00:00Z',
      },
    ],
  })

it('starts a new chat on the model the user picked last, not the open chat’s', async () => {
  signIn({
    session: sessionWithOtherModel,
    profile: { selectedModel: otherModel.id },
  })
  await localThreadStore('device').add(savedChat('test-model'))
  render(view('saved-chat'))
  await screen.findByText('A saved question')
  expect(
    screen.getAllByRole('button', { name: 'Current model Test model' })[0],
  ).toBeInTheDocument()

  fireEvent.click(screen.getAllByRole('link', { name: 'New chat' })[0])

  await waitFor(() =>
    expect(screen.queryByText('A saved question')).not.toBeInTheDocument(),
  )
  expect(
    screen.getAllByRole('button', { name: 'Current model Other model' })[0],
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Current model Test model' }),
  ).not.toBeInTheDocument()
})

it('continues a chat whose model was retired on the model the user picked', async () => {
  signIn({
    session: sessionWithOtherModel,
    profile: { selectedModel: otherModel.id },
  })
  answerTurns()
  await localThreadStore('device').add(savedChat('retired-model'))
  render(view('saved-chat'))
  await screen.findByText('A saved question')
  expect(
    screen.getAllByRole('button', { name: 'Current model Other model' })[0],
  ).toBeInTheDocument()

  await send('And now?')

  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(sentTurns()[0].options?.model).toBe(otherModel.id)
})

it('keeps the draft, its attachment and quote when starting a new chat or opening another', async () => {
  signIn()
  answerTurns()
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  const store = localThreadStore('device')
  await store.add(
    storedThread('first-chat', {
      title: 'First chat',
      messages: [
        {
          id: 'first-question',
          role: 'user',
          content: 'Which door should I paint?',
          createdAt: '2026-10-22T12:00:00Z',
        },
      ],
    }),
  )
  await store.add(
    storedThread('second-chat', {
      title: 'Second chat',
      messages: [
        {
          id: 'second-question',
          role: 'user',
          content: 'A different conversation',
          createdAt: '2026-10-22T12:00:00Z',
        },
      ],
    }),
  )
  const notes = {
    id: 'att-notes',
    kind: 'document',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    size: 4,
  }
  client.upload.mockResolvedValue({ attachment: notes })
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  const { rerender } = render(view('first-chat'))
  const question = await screen.findByText('Which door should I paint?')

  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'My unfinished draft' },
  })
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [new File(['note'], notes.fileName)] },
  })
  await screen.findByText('Document')
  const range = document.createRange()
  range.setStart(question.firstChild!, 6)
  range.setEnd(question.firstChild!, 10)
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(100, 100, 120, 20),
  )
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
  window.getSelection()!.removeAllRanges()

  const expectDraft = () => {
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'My unfinished draft',
    )
    expect(
      screen.getByRole('button', { name: 'Remove notes.txt' }),
    ).toBeInTheDocument()
    expect(screen.getByText('door')).toBeInTheDocument()
  }
  expectDraft()

  fireEvent.click(screen.getByRole('link', { name: 'Second chat' }))
  await waitFor(() =>
    expect(chatPage.router.push).toHaveBeenCalledWith(
      '/chat/local/second-chat',
      undefined,
      { shallow: true },
    ),
  )
  rerender(view('second-chat'))
  await screen.findByText('A different conversation')
  expectDraft()

  fireEvent.click(screen.getAllByRole('link', { name: 'New chat' })[0])
  await waitFor(() =>
    expect(chatPage.router.push).toHaveBeenLastCalledWith('/', undefined, {
      shallow: true,
    }),
  )
  rerender(view())
  await waitFor(() =>
    expect(
      screen.queryByText('A different conversation'),
    ).not.toBeInTheDocument(),
  )
  expectDraft()

  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sentTurns()).toHaveLength(1))
  expect(sentTurns()[0].threadId).not.toBe('second-chat')
  expect(sentTurns()[0]).toMatchObject({
    content: 'My unfinished draft',
    quote: 'door',
  })
  expect(sentTurns()[0].attachments).toEqual([notes])
})

it('explains a file over its size limit before uploading it', async () => {
  const limit = 2 * 1024 * 1024
  signIn({
    session: {
      ...testSession,
      composer: {
        ...testSession.composer,
        attachments: [{ accept: ['.pdf'], maxBytes: limit }],
      },
    },
  })
  render(
    <>
      {view()}
      <Toaster />
    </>,
  )
  await screen.findByRole('textbox', { name: 'Message' })

  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [new File([new Uint8Array(limit + 1)], 'report.pdf')] },
  })

  expect(await screen.findByText('Processing failed')).toBeInTheDocument()
  expect(
    screen.getByText('File size exceeds the limit of 2MB.'),
  ).toBeInTheDocument()
  expect(client.upload).not.toHaveBeenCalled()
})
