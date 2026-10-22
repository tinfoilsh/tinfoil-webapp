import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import type { Thread } from '@/services/harness/types'
import { resetSafeguards } from '@/services/safeguards'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => (await import('./chat-page-mocks')).dynamic)
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-projects',
  async () => (await import('./chat-page-mocks')).projects,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock(
  '@/components/project',
  async () => (await import('./chat-page-mocks')).project,
)
vi.mock(
  '@/components/chat/chat-sidebar',
  async () => (await import('./chat-page-mocks')).chatSidebar,
)
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

const THREAD_ID = 'thread-1'
const thread: Thread = {
  id: THREAD_ID,
  title: 'A chat',
  titleState: 'generated',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:00Z',
  model: 'test-model',
  projectId: null,
  pinned: false,
  webSearchEnabled: true,
  messageCount: 2,
  activeRun: null,
  hasOlder: false,
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'Hi',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:01Z',
      timeline: [{ id: 'b1', type: 'content', content: 'Hello there' }],
    },
  ],
}
function open() {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path: string, input) => {
    if (path === '/v1/threads/get')
      return (input as { id: string }).id === THREAD_ID
        ? structuredClone(thread)
        : { ...structuredClone(thread), id: 'fork-1', title: 'A chat (fork)' }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/fork')
      return {
        ...structuredClone(thread),
        id: 'fork-1',
        title: 'A chat (fork)',
        messages: undefined,
      }
    if (path === '/v1/threads/messages/delete')
      return { ...structuredClone(thread), messages: [thread.messages[1]] }
    throw new Error(`Unexpected ${path}`)
  })
  render(<ChatInterface initialChatId={THREAD_ID} />)
}

async function moreActions() {
  await screen.findByText('Hello there')
  return screen.queryByRole('button', { name: 'More actions' })
}

beforeEach(() => {
  authTokenManager.initialize(async () => 'clerk-jwt')
  refuseFetch()
  chatPage.router.replace.mockClear()
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  resetSafeguards()
  authTokenManager.reset()
})

describe('message actions on the chat page', () => {
  it.each([390, 900, 1440])(
    'keeps the chat layout visible while another chat loads at %ipx',
    async (width) => {
      vi.stubGlobal('innerWidth', width)
      signIn({ cloud: true })
      const nextThread: Thread = {
        ...structuredClone(thread),
        id: 'next-thread',
        title: 'Another chat',
        messages: [
          {
            id: 'next-user',
            role: 'user',
            createdAt: thread.createdAt,
            content: 'A different conversation',
          },
        ],
        messageCount: 1,
      }
      let finishLoading!: (thread: Thread) => void
      const loading = new Promise<Thread>((resolve) => {
        finishLoading = resolve
      })
      client.post.mockImplementation(async (path, input) => {
        if (path === '/v1/threads/list')
          return { threads: [], nextCursor: null }
        if (path === '/v1/threads/get') {
          return (input as { id: string }).id === THREAD_ID
            ? structuredClone(thread)
            : loading
        }
        throw new Error(`Unexpected ${path}`)
      })
      client.events.mockImplementation(async function* (_path, input) {
        yield {
          id: 0,
          event: {
            type: 'RUN_STARTED',
            threadId: input.threadId!,
            runId: 'loaded-chat-run',
          },
        }
        yield {
          id: 1,
          event: {
            type: 'RUN_FINISHED',
            threadId: input.threadId!,
            runId: 'loaded-chat-run',
          },
        }
      })
      const { rerender } = render(
        <ChatInterface initialChatId={THREAD_ID} suppressIntroModals />,
      )
      await screen.findByText('Hello there')
      const header = screen
        .getByRole('heading', { level: 1, name: 'A chat' })
        .closest('header')
      const input = screen.getByRole('textbox', { name: /message/i })
      const inputArea = input.closest('[data-chat-input-area]')
      fireEvent.change(input, { target: { value: 'My next question' } })

      rerender(
        <ChatInterface initialChatId={nextThread.id} suppressIntroModals />,
      )
      await screen.findByRole('status', { name: 'Loading chat history' })
      expect(
        screen
          .getByRole('heading', { level: 1, name: 'Loading chat…' })
          .closest('header'),
      ).toBe(header)
      const loadingInput = screen.getByRole('textbox', { name: /message/i })
      expect(loadingInput.closest('[data-chat-input-area]')).toBe(inputArea)
      expect(loadingInput).toHaveValue('My next question')
      expect(loadingInput).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
      expect(screen.queryByText('Hello there')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Temporary chat' }),
      ).not.toBeInTheDocument()
      fireEvent.submit(loadingInput.closest('form')!)
      expect(client.events).not.toHaveBeenCalled()

      await act(async () => {
        finishLoading(nextThread)
      })
      expect(
        screen.queryByRole('status', { name: 'Loading chat history' }),
      ).not.toBeInTheDocument()
      expect(
        screen
          .getByRole('heading', { level: 1, name: nextThread.title })
          .closest('header'),
      ).toBe(header)
      expect(screen.getByText('A different conversation')).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: /message/i })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
      expect(client.events.mock.calls[0][1]).toMatchObject({
        threadId: nextThread.id,
        content: 'My next question',
      })
    },
  )

  it('sends a selected quote without requiring extra text', async () => {
    open()
    const message = await screen.findByText('Hello there')
    const range = document.createRange()
    range.selectNodeContents(message)
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 100, 120, 20),
    )
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(await screen.findByRole('button', { name: 'Quote' }))
    client.events.mockImplementation(async function* (_path, input) {
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId: input.threadId!,
          runId: 'quoted',
        },
      }
      yield {
        id: 1,
        event: {
          type: 'RUN_FINISHED',
          threadId: input.threadId!,
          runId: 'quoted',
        },
      }
    })
    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
    expect(client.events.mock.calls[0][1]).toMatchObject({
      kind: 'send',
      content: '',
      quote: 'Hello there',
    })
  })
  it("offers a stored chat's message actions", async () => {
    open()

    fireEvent.click((await moreActions())!)
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual([
      'Continue response',
      'Edit response',
      'Fork conversation from here',
      'Delete message',
    ])
  })

  it('deletes a message once the deletion is confirmed', async () => {
    open()
    await screen.findByText('Hello there')

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    expect(
      client.post.mock.calls.some(
        ([path]) => path === '/v1/threads/messages/delete',
      ),
    ).toBe(false)
    fireEvent.click(
      within(
        screen.getByRole('alertdialog', { name: 'Delete message?' }),
      ).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() =>
      expect(client.post).toHaveBeenCalledWith(
        '/v1/threads/messages/delete',
        { key: KEY, threadId: THREAD_ID, messageId: 'u1' },
        expect.any(AbortSignal),
      ),
    )
    await waitFor(() =>
      expect(screen.queryByText('Hi')).not.toBeInTheDocument(),
    )
  })

  it('forks a stored chat and moves to the fork', async () => {
    open()
    fireEvent.click((await moreActions())!)

    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Fork conversation from here' }),
    )

    expect(
      await screen.findByRole('status', { name: 'Forking conversation' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(chatPage.router.replace).toHaveBeenCalledWith(
        '/chat/fork-1',
        undefined,
        { shallow: true },
      ),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/fork',
      { key: KEY, threadId: THREAD_ID, messageId: 'a1' },
      expect.any(AbortSignal),
    )
  })
})

describe('attachments on the chat page', () => {
  it('sends what an upload returned, never the picked file, in the message that uses it', async () => {
    open()
    await screen.findByText('Hello there')
    const bytes = new Uint8Array([137, 80, 78, 71])
    const descriptor = {
      id: 'att_door',
      kind: 'image',
      fileName: 'door.png',
      mimeType: 'image/png',
      size: 4,
      thumbnail: 'dGh1bWI=',
      base64: 'bW9kZWwtY29weQ==',
    }
    client.upload.mockResolvedValueOnce({ attachment: descriptor })
    client.events.mockImplementation(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-2' },
      }
    })

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File([bytes], 'door.png', { type: 'image/png' })] },
    })
    await waitFor(() =>
      expect(
        document.querySelector('img[src="data:image/png;base64,dGh1bWI="]'),
      ).not.toBeNull(),
    )
    const composer = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(composer, { target: { value: 'What door?' } })
    fireEvent.submit(composer.closest('form')!)
    await waitFor(() => expect(client.events).toHaveBeenCalledOnce())

    expect(client.upload).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/upload',
      expect.any(File),
      {},
      expect.any(AbortSignal),
    )
    expect(client.events.mock.calls[0][1]).toMatchObject({
      threadId: THREAD_ID,
      content: 'What door?',
    })
    expect(client.events.mock.calls[0][1].attachments).toEqual([descriptor])
  })
})
