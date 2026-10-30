import { ChatInterface } from '@/components/chat/chat-interface'
import { getView } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Thread, Turn } from '@/services/harness/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage, errorHandling } from './chat-page-mocks'

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
  chatPage.premium = false
  errorHandling.logError.mockClear()
  refuseFetch()
  signIn({ cloud: true })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
})

describe('a turn the harness refuses', () => {
  it('rechecks the harness entitlement after a subscription upgrade', async () => {
    const api = signIn({
      cloud: true,
      session: {
        ...testSession,
        rateLimit: { kind: 'free_daily', maxRequests: 5, remaining: 0 },
      },
    })
    api.reportRateLimit({ kind: 'free_daily', maxRequests: 5, remaining: 0 })
    // The browser mints the subscriber's chat access, whose quota the control
    // plane reports; the harness reports none for it.
    client.renewCredential.mockImplementation(async () =>
      client.onRateLimit?.({
        kind: 'hourly',
        inputTokens: { max: 10000, used: 0, remaining: 10000 },
      }),
    )
    client.post.mockImplementation(async (path, input) => {
      if (path === '/v1/session') {
        expect(input).toEqual({})
        return testSession
      }
      if (path === '/v1/profile/get') return {}
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    const { rerender } = render(<ChatInterface />)
    expect(getView().rateLimit?.kind).toBe('free_daily')
    const refresh = vi.spyOn(api, 'refresh')
    await act(async () => {
      chatPage.premium = true
      rerender(<ChatInterface />)
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await act(async () => {
      await refresh.mock.results[0].value
    })
    expect(getView().rateLimit?.kind).toBe('hourly')
    expect(client.renewCredential).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed recheck after a subscription change out of the reply error banner', async () => {
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/session') throw new TypeError('Network unavailable')
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    const { rerender } = render(<ChatInterface />)
    await screen.findByRole('textbox', { name: /message/i })

    await act(async () => {
      chatPage.premium = true
      rerender(<ChatInterface />)
    })

    await waitFor(() =>
      expect(
        errorHandling.logError.mock.calls.map(([message]) => message),
      ).toContain('Failed to refresh after a subscription change'),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/session',
      {},
      expect.any(AbortSignal),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
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
  it.each([
    [
      'a lost connection',
      new TypeError('Failed to fetch'),
      'Connection problemCheck your internet connection, then resend your message. Your message was not lost.',
      false,
    ],
    [
      'the hourly limit',
      new HarnessError(
        { code: 'RATE_LIMITED', message: 'You reached the hourly limit' },
        429,
      ),
      'Too many requests right nowWait a moment, then resend your message. Your message was not lost.',
      false,
    ],
    [
      'a connection lost once the harness queued it',
      new TypeError('Failed to fetch'),
      'Connection problemCheck your internet connection, then resend your message. Your message was not lost.',
      true,
    ],
  ])(
    'keeps the reply streaming when %s refuses a message queued behind it',
    async (_refusal, refusal, explanation, queued) => {
      const { messages: _messages, hasOlder: _hasOlder, ...summary } = thread
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      client.events.mockImplementationOnce(async function* () {
        const frames: Frame['event'][] = [
          { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
          { type: 'STATE_SNAPSHOT', snapshot: { thread: summary, queue: [] } },
        ]
        for (const [id, event] of frames.entries()) yield { id, event }
        await held
        yield {
          id: frames.length,
          event: {
            type: 'TEXT_MESSAGE_CHUNK',
            messageId: 'a1',
            delta: ' and more',
          },
        }
        await finished
      })
      client.events.mockImplementationOnce(async function* () {
        if (queued)
          yield {
            id: 0,
            event: {
              type: 'STATE_DELTA',
              runId: 'run-2',
              delta: [
                {
                  op: 'add',
                  path: '/queue/-',
                  value: { queueId: 'run-2', content: 'And one more' },
                },
              ],
            },
          } satisfies Frame
        throw refusal
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

      expect(await screen.findByRole('alert')).toHaveTextContent(explanation)
      expect(
        screen.getByRole('button', { name: 'Stop generation' }),
      ).toBeInTheDocument()
      await act(async () => release())
      expect(screen.getByText('Hello there and more')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Stop generation' }),
      ).toBeInTheDocument()
      finish()
    },
  )
})
