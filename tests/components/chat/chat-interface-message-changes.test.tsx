import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import { HarnessError } from '@/services/harness/sse'
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
const refusal = new HarnessError(
  { code: 'THREAD_NOT_FOUND', message: 'The message was not found' },
  404,
)

// Opens the chat, whose message changes the harness holds until the test
// refuses them.
async function openHeld() {
  signIn({ cloud: true })
  let refuse!: (cause: unknown) => void
  const held = new Promise<never>((_, reject) => {
    refuse = reject
  })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (
      path === '/v1/threads/messages/update' ||
      path === '/v1/threads/messages/delete'
    )
      return held
    throw new Error(`Unexpected ${path}`)
  })
  render(<ChatInterface initialChatId={THREAD_ID} />)
  await screen.findByText('Hello there')
  return () => act(async () => refuse(refusal))
}

beforeEach(() => {
  authTokenManager.initialize(async () => 'clerk-jwt')
  refuseFetch()
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
})

describe('changing a message on the chat page', () => {
  it('shows a rewritten reply at once, and its text again in the editor when the harness refuses it', async () => {
    const refuse = await openHeld()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit response' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit response' }), {
      target: { value: 'A better reply' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(client.post).toHaveBeenCalledWith(
        '/v1/threads/messages/update',
        {
          key: KEY,
          threadId: THREAD_ID,
          messageId: 'a1',
          content: 'A better reply',
        },
        expect.any(AbortSignal),
      ),
    )
    expect(screen.getByText('A better reply')).toBeInTheDocument()
    expect(screen.queryByText('Hello there')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Edit response' }),
    ).not.toBeInTheDocument()

    await refuse()

    expect(screen.getByRole('textbox', { name: 'Edit response' })).toHaveValue(
      'A better reply',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.queryByText('A better reply')).not.toBeInTheDocument()
  })

  it('removes a deleted message at once, and shows it again when the harness refuses', async () => {
    const refuse = await openHeld()
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))

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
    expect(screen.queryByText('Hi')).not.toBeInTheDocument()
    expect(screen.getByText('Hello there')).toBeInTheDocument()

    await refuse()

    expect(screen.getByText('Hi')).toBeInTheDocument()
    expect(screen.getByText('Hello there')).toBeInTheDocument()
  })
})
