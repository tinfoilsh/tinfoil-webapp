import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Thread } from '@/services/harness/types'
import { resetSafeguards } from '@/services/safeguards'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const THREAD_ID = 'thread-1'
const thread: Thread = {
  id: THREAD_ID,
  title: 'A draft',
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
      content: 'Draft a reply',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:01Z',
      content: 'Here it is.',
      model: 'earlier-model',
      modelDisplayName: 'Earlier model',
      timeline: [
        {
          id: 'w1',
          type: 'tool_call',
          toolCallId: 'w1',
          name: 'render_message_compose',
          arguments: '{"title":"Reply draft"}',
          complete: true,
          invalidArguments: true,
        },
        { id: 'c1', type: 'content', content: 'Here it is.' },
      ],
    },
  ],
}

beforeEach(() => {
  authTokenManager.initialize(async () => 'clerk-jwt')
  refuseFetch()
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
})

// Opens the chat, whose widget's retry run the harness answers with `run`.
async function openChat(run?: () => AsyncGenerator<Frame>) {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  if (run) client.events.mockImplementation(run)
  render(<ChatInterface initialChatId={THREAD_ID} />)
  await screen.findByText("Couldn't display message compose")
}

const clickRetry = () =>
  act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' })),
  )

// Opens the chat, and retries its widget with a harness that answers the
// retry's run with `run`.
async function retryWidget(run: () => AsyncGenerator<Frame>) {
  await openChat(run)
  await clickRetry()
  expect(client.events).toHaveBeenCalledExactlyOnceWith(
    '/v1/threads/turn',
    expect.objectContaining({
      kind: 'retryToolCall',
      threadId: THREAD_ID,
      messageId: 'a1',
      toolCallId: 'w1',
      content: '',
    }),
    expect.any(AbortSignal),
  )
}

// A retry's run that ends with the harness's error.
const failedRun = (code: string) =>
  async function* (): AsyncGenerator<Frame> {
    const events: Frame['event'][] = [
      { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-retry' },
      {
        type: 'RUN_ERROR',
        threadId: THREAD_ID,
        runId: 'run-retry',
        code,
        message: 'The retry failed.',
      },
    ]
    for (const [id, event] of events.entries()) yield { id, event }
  }

describe('retrying a widget on the chat page', () => {
  it('asks a free account out of daily requests to subscribe instead', async () => {
    await openChat()
    act(() =>
      publish({
        rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 0 },
      }),
    )
    await clickRetry()

    expect(
      await screen.findByRole('dialog', { name: 'No more free requests' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Could not request a replacement. Try the widget again.',
      ),
    ).toBeInTheDocument()
    expect(client.events).not.toHaveBeenCalled()
  })

  it('draws the widget again from the arguments the harness sends', async () => {
    await retryWidget(async function* (): AsyncGenerator<Frame> {
      const events: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-retry' },
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'a1',
          toolCallId: 'w1',
          toolCallName: 'render_message_compose',
        },
        {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'w1',
          delta: JSON.stringify({
            channel: 'message',
            title: 'Reply draft',
            variants: [{ label: 'Concise', body: 'Thanks.' }],
          }),
        },
        { type: 'TOOL_CALL_END', toolCallId: 'w1' },
        { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-retry' },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })

    expect(await screen.findByText('Reply draft')).toBeInTheDocument()
    expect(
      screen.queryByText("Couldn't display message compose"),
    ).not.toBeInTheDocument()
  })

  it('keeps the model that wrote the reply once its widget is redrawn', async () => {
    await retryWidget(async function* (): AsyncGenerator<Frame> {
      const events: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-retry' },
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'a1',
          toolCallId: 'w1',
          toolCallName: 'render_message_compose',
        },
        {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'w1',
          delta: JSON.stringify({
            channel: 'message',
            title: 'Reply draft',
            variants: [{ label: 'Concise', body: 'Thanks.' }],
          }),
        },
        { type: 'TOOL_CALL_END', toolCallId: 'w1' },
        {
          type: 'RUN_FINISHED',
          threadId: THREAD_ID,
          runId: 'run-retry',
          metadata: {
            messages: [
              {
                id: 'a1',
                model: 'test-model',
                modelDisplayName: 'Test model',
                isError: false,
                isInterrupted: false,
              },
            ],
          },
        },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })

    expect(await screen.findByText('Reply draft')).toBeInTheDocument()
    const reply = screen.getByRole('article', { name: 'Al said' })
    expect(within(reply).getByText('Earlier model')).toBeInTheDocument()
    expect(within(reply).queryByText('Test model')).not.toBeInTheDocument()
  })

  it("shows neither the retry's run nor its error as the chat's", async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    let fail!: () => void
    const failing = new Promise<void>((resolve) => {
      fail = resolve
    })
    await retryWidget(async function* (): AsyncGenerator<Frame> {
      yield {
        id: 0,
        event: { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-retry' },
      }
      yield {
        id: 1,
        event: {
          type: 'MESSAGES_SNAPSHOT',
          messages: thread.messages,
          hasOlder: false,
        },
      }
      // The run's frames so far were applied once the next one is asked for.
      started()
      await failing
      yield {
        id: 2,
        event: {
          type: 'RUN_ERROR',
          threadId: THREAD_ID,
          runId: 'run-retry',
          code: 'UPSTREAM_REFUSED',
          message: 'The replacement widget arguments do not match the schema',
        },
      }
    })

    await act(() => running)
    expect(
      screen.queryByRole('button', { name: 'Stop generation' }),
    ).not.toBeInTheDocument()
    await act(async () => fail())

    expect(
      await screen.findByText(
        'Could not request a replacement. Try the widget again.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('The service is having trouble right now'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    {
      failure: 'a widget call the harness no longer has',
      run: async function* (): AsyncGenerator<Frame> {
        throw new HarnessError(
          {
            code: 'THREAD_NOT_FOUND',
            message: 'The widget call was not found',
          },
          404,
        )
      },
      says: 'The component is no longer available to repair.',
    },
    {
      failure: 'a widget the client is no longer offered',
      run: async function* (): AsyncGenerator<Frame> {
        throw new HarnessError(
          {
            code: 'TOOL_UNAVAILABLE',
            message: 'This widget is not enabled for the client',
          },
          503,
        )
      },
      says: 'The component is no longer available to repair.',
    },
    {
      failure: 'a widget that changed during the retry',
      run: failedRun('REVISION_CONFLICT'),
      says: 'The component changed while retrying. Try its current version.',
    },
    {
      failure: 'a replacement the model could not give',
      run: failedRun('UPSTREAM_REFUSED'),
      says: 'Could not request a replacement. Try the widget again.',
    },
  ])('says why it failed for $failure', async ({ run, says }) => {
    await retryWidget(run)

    expect(await screen.findByText(says)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Retry widget' }),
    ).toBeInTheDocument()
  })
})
