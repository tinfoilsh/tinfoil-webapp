import { ChatInterface } from '@/components/chat/chat-interface'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Thread, Turn } from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
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

const THREAD_ID = 'thread-busy'
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
  activeRun: { runId: 'run-1', expiresAt: '2026-04-01T10:00:00Z' },
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

const turn = (call: number) => client.events.mock.calls[call][1] as Turn

beforeEach(() => {
  refuseFetch()
  signIn({ cloud: true })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
})

describe('a turn the harness refuses', () => {
  it('explains a full queue without the quota or upgrade, and resends the message', async () => {
    const { messages: _messages, hasOlder: _hasOlder, ...summary } = thread
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementationOnce(async function* () {
      const frames: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
        { type: 'STATE_SNAPSHOT', snapshot: { thread: summary, queue: [] } },
      ]
      for (const [id, event] of frames.entries()) yield { id, event }
      await held
    })
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        { code: 'QUEUE_FULL', message: 'The turn queue is full' },
        429,
      )
    })
    client.events.mockImplementationOnce(async function* () {
      await held
    })
    render(<ChatInterface initialChatId={THREAD_ID} />)
    await screen.findByText('Hello there')
    await waitFor(() =>
      expect(client.events).toHaveBeenCalledWith(
        '/v1/threads/follow',
        expect.objectContaining({ runId: 'run-1' }),
        expect.any(AbortSignal),
      ),
    )
    const input = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: 'And one more' } })
    fireEvent.submit(input.closest('form')!)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Too many messages are waiting in this chat',
    )
    expect(alert).not.toHaveTextContent(/limit/i)
    expect(
      screen.queryByRole('button', { name: 'Upgrade to Premium' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))

    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(3))
    expect(client.events.mock.calls[2][0]).toBe('/v1/threads/turn')
    expect(turn(1)).toMatchObject({ kind: 'send', content: 'And one more' })
    expect(turn(2)).toEqual(turn(1))
    release()
  })
})
