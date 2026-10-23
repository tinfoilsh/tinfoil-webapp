import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { USER_PREFS_LOCAL_PROFILE } from '@/constants/storage-keys'
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
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
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

function view() {
  return (
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
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
