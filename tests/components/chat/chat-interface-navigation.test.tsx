import { ChatInterface } from '@/components/chat/chat-interface'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import type { Thread } from '@/services/harness/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
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
vi.mock('@/components/project/project-context', () => ({
  useProject: () => ({ activeProject: null, deleteProject: vi.fn() }),
}))
vi.mock('@/components/chat/sidebar-account-menu', () => ({
  SidebarAccountMenu: () => null,
}))
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

resetChatStoresAroundEachTest()

const DESKTOP_WIDTH = 1440
const first: Thread = {
  ...storedThread('first-chat', {
    title: 'First chat',
    messages: [
      {
        id: 'first-message',
        role: 'user',
        createdAt: '2026-10-22T12:00:00Z',
        content: 'First conversation',
      },
    ],
  }),
  messageCount: 1,
  hasOlder: false,
}
const second: Thread = {
  ...storedThread('second-chat', {
    title: 'Second chat',
    messages: [
      {
        id: 'second-message',
        role: 'user',
        createdAt: '2026-10-22T12:00:00Z',
        content: 'Second conversation',
      },
    ],
  }),
  messageCount: 1,
  hasOlder: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.router.push.mockReset().mockResolvedValue(true)
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
  signIn({ cloud: true })
})

function open(firstResponse: Promise<Thread>) {
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/threads/list')
      return { threads: [first, second], nextCursor: null }
    if (path === '/v1/threads/get') {
      const id = (input as { id: string }).id
      if (id === first.id) return firstResponse
      if (id === second.id) return structuredClone(second)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatInterface suppressIntroModals />)
}

it('shows a sidebar selection before the chat request finishes', async () => {
  const pending = deferred<Thread>()
  open(pending.promise)
  const link = await screen.findByRole('link', { name: first.title })
  fireEvent.click(link)
  await screen.findByRole('status', { name: 'Loading chat history' })
  expect(link).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    first.title,
  )
  expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled()
  await act(async () => pending.resolve(first))
  expect(screen.getByText('First conversation')).toBeInTheDocument()
})

it.each(['success', 'failure'])(
  'keeps the latest selection after an older request ends in %s',
  async (outcome) => {
    const pending = deferred<Thread>()
    open(pending.promise)
    fireEvent.click(await screen.findByRole('link', { name: first.title }))
    await screen.findByRole('status', { name: 'Loading chat history' })
    fireEvent.click(screen.getByRole('link', { name: second.title }))
    await screen.findByText('Second conversation')
    await waitFor(() =>
      expect(chatPage.router.push).toHaveBeenCalledWith(
        '/chat/second-chat',
        undefined,
        { shallow: true },
      ),
    )

    await act(async () => {
      if (outcome === 'success') pending.resolve(first)
      else pending.reject(new Error('The earlier chat request failed'))
    })

    expect(chatPage.router.push).toHaveBeenCalledExactlyOnceWith(
      '/chat/second-chat',
      undefined,
      { shallow: true },
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      second.title,
    )
    expect(screen.getByRole('link', { name: second.title })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.queryByText('First conversation')).not.toBeInTheDocument()
    expect(
      screen.queryByText('The earlier chat request failed'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  },
)
