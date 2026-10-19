import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import type { Frame, Thread } from '@/services/harness/types'
import { resetSafeguards } from '@/services/safeguards'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { safeguardFlags, stubSafeguardFlags } from './chat-interface-fixture'

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

const THREAD_ID = 'thread-flagged'
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

let flags: { conversation_id: string }[]
let flagsResponse: (() => Promise<Response>) | undefined

function composer() {
  return screen.getByRole('textbox', { name: /message/i })
}

function send(text: string) {
  const input = composer()
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input.closest('form')!)
}

beforeEach(() => {
  flags = []
  flagsResponse = undefined
  authTokenManager.initialize(async () => 'clerk-jwt')
  stubSafeguardFlags(() =>
    flagsResponse ? flagsResponse() : safeguardFlags(flags),
  )
  signIn({ cloud: true })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
})

describe('a chat the safeguards flagged', () => {
  it('is read-only', async () => {
    flags = [{ conversation_id: THREAD_ID }]
    render(<ChatInterface initialChatId={THREAD_ID} />)

    expect(
      await screen.findByText('This chat was flagged by a safeguard model.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Regenerate response' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Edit message' }),
    ).not.toBeInTheDocument()
  })

  it('is a normal chat while it has no flag', async () => {
    render(<ChatInterface initialChatId={THREAD_ID} />)

    expect(await screen.findByText('Hello there')).toBeInTheDocument()
    await waitFor(() => expect(composer()).toBeInTheDocument())
    expect(
      screen.queryByText('This chat was flagged by a safeguard model.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: 'Regenerate response' }).length,
    ).toBeGreaterThan(0)
  })

  it('stops its reply in progress and its queued turns once a flag arrives', async () => {
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/get')
        return {
          ...structuredClone(thread),
          activeRun: { runId: 'run-1', expiresAt: '2026-04-01T10:00:00Z' },
        }
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (['/v1/threads/cancel', '/v1/threads/queue/remove'].includes(path))
        return {}
      throw new Error(`Unexpected ${path}`)
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementationOnce(async function* () {
      const frames: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
        {
          type: 'STATE_SNAPSHOT',
          snapshot: {
            thread: null,
            queue: [{ queueId: 'queued-1', content: 'and then?' }],
          },
        },
      ]
      for (const [id, event] of frames.entries()) yield { id, event }
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
    expect(
      client.post.mock.calls.some(([path]) => path === '/v1/threads/cancel'),
    ).toBe(false)

    flags = [{ conversation_id: THREAD_ID }]
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(
      await screen.findByText('This chat was flagged by a safeguard model.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(client.post).toHaveBeenCalledWith(
        '/v1/threads/cancel',
        { key: KEY, threadId: THREAD_ID, runId: 'run-1' },
        expect.any(AbortSignal),
      ),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/queue/remove',
      { key: KEY, threadId: THREAD_ID, queueId: 'queued-1' },
      expect.any(AbortSignal),
    )
    release()
  })

  it('holds a send until the flags load, then sends it once', async () => {
    let respond!: () => void
    flagsResponse = () =>
      new Promise((resolve) => {
        respond = () => resolve(safeguardFlags(flags))
      })
    client.events.mockImplementation(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-2' },
      }
    })
    render(<ChatInterface initialChatId={THREAD_ID} />)
    await screen.findByText('Hello there')
    await waitFor(() => expect(composer()).toBeInTheDocument())

    send('Are you there?')
    expect(client.events).not.toHaveBeenCalled()

    flagsResponse = undefined
    await act(async () => respond())

    await waitFor(() => expect(client.events).toHaveBeenCalledOnce())
    expect(client.events.mock.calls[0][1]).toMatchObject({
      kind: 'send',
      threadId: THREAD_ID,
      content: 'Are you there?',
    })
  })

  it('drops a held send when the loaded flags mark the chat', async () => {
    let respond!: () => void
    flagsResponse = () =>
      new Promise((resolve) => {
        respond = () => resolve(safeguardFlags(flags))
      })
    render(<ChatInterface initialChatId={THREAD_ID} />)
    await screen.findByText('Hello there')
    await waitFor(() => expect(composer()).toBeInTheDocument())

    send('Are you there?')
    flags = [{ conversation_id: THREAD_ID }]
    flagsResponse = undefined
    await act(async () => respond())

    expect(
      await screen.findByText('This chat was flagged by a safeguard model.'),
    ).toBeInTheDocument()
    expect(client.events).not.toHaveBeenCalled()
  })
})
