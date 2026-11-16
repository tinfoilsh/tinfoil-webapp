import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import { HarnessError } from '@/services/harness/sse'
import type {
  Connector,
  ConnectorCall,
  Frame,
  Message,
  Thread,
  ToolDisplay,
} from '@/services/harness/types'
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
import { client, KEY, signIn, testSession } from '../../harness-fixture'
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
const RUN_ID = 'run-1'
const APPROVAL_ID = 'approval-1'
const session = {
  ...testSession,
  features: { ...testSession.features, connectors: true },
}

const question: Message = {
  id: 'u1',
  role: 'user',
  createdAt: '2026-11-01T09:00:00Z',
  content: 'Write down our plans',
}

const NOTION: Connector = {
  id: 'connector-1',
  name: 'Notion',
  url: 'https://mcp.notion.com/mcp',
  enabled: true,
  status: 'connected',
  signIn: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  tools: [{ name: 'create_page', title: 'Create a page', permission: 'ask' }],
}

// A stored chat whose reply is running on the harness.
const chat: Thread = {
  id: THREAD_ID,
  title: 'Plans',
  titleState: 'generated',
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  activityAt: '2026-11-01T09:00:00Z',
  model: 'test-model',
  projectId: null,
  presetId: null,
  pinned: false,
  webSearchEnabled: true,
  contextUsage: null,
  messageCount: 1,
  activeRun: {
    runId: RUN_ID,
    instance: 'instance-1',
    expiresAt: '2099-01-01T00:00:00Z',
  },
  hasOlder: false,
  messages: [question],
}

const display = (
  status: string,
  approval?: ConnectorCall['approval'],
): ToolDisplay => ({
  status,
  sources: [],
  connector: {
    id: NOTION.id,
    name: NOTION.name,
    url: NOTION.url,
    tool: 'create_page',
    title: 'Create a page',
    ...(approval ? { approval } : {}),
  },
})

const activity = (event: Partial<Frame['event']>) =>
  ({
    messageId: 'act_call-1',
    activityType: 'TOOL',
    ...event,
  }) as Frame['event']

// Follows the chat's run, whose call to Notion waits for approval until
// `answered` settles, then runs and finishes the reply.
function followRun(answered: Promise<boolean>) {
  client.events.mockImplementation(async function* () {
    const waiting: Frame['event'][] = [
      {
        type: 'RUN_STARTED',
        threadId: THREAD_ID,
        runId: RUN_ID,
        instance: 'instance-1',
      },
      { type: 'MESSAGES_SNAPSHOT', messages: [question], hasOlder: false },
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'a1',
        toolCallId: 'call-1',
        toolCallName: 'notion__create_page',
      },
      {
        type: 'TOOL_CALL_ARGS',
        toolCallId: 'call-1',
        delta: '{"title":"Plans"}',
      },
      { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
      activity({
        type: 'ACTIVITY_SNAPSHOT',
        content: {
          toolCallId: 'call-1',
          tool: 'notion__create_page',
          progress: 0,
          output: [],
        },
        display: display('running'),
      }),
      activity({
        type: 'ACTIVITY_DELTA',
        patch: [],
        display: display('running', {
          id: APPROVAL_ID,
          status: 'pending',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      }),
    ]
    for (const [id, event] of waiting.entries()) yield { id, event }
    const approved = await answered
    const approval = { status: approved ? 'approved' : 'declined' }
    const rest: Frame['event'][] = [
      ...(approved
        ? [
            activity({
              type: 'ACTIVITY_DELTA',
              patch: [],
              display: display('running', approval),
            }),
          ]
        : []),
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 'tool-1',
        toolCallId: 'call-1',
        role: 'tool',
        content: approved
          ? { output: 'Created "Plans"' }
          : { error: 'declined' },
        display: display(approved ? 'completed' : 'failed', approval),
      },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'a1',
        role: 'assistant',
        delta: approved ? 'Saved your plans.' : 'I left your plans alone.',
      },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: RUN_ID,
        metadata: {},
      },
    ]
    for (const [index, event] of rest.entries())
      yield { id: waiting.length + index, event }
  })
}

let approve: (input: unknown) => Promise<unknown>

beforeEach(() => {
  authTokenManager.initialize(async () => 'clerk-jwt')
  refuseFetch()
  signIn({ cloud: true, session })
  approve = async () => ({ accepted: true })
  client.post.mockImplementation(async (path: string, input: unknown) => {
    switch (path) {
      case '/v1/session':
        return structuredClone(session)
      case '/v1/threads/get':
        return structuredClone(chat)
      case '/v1/threads/list':
        return { threads: [], nextCursor: null }
      case '/v1/connectors/list':
        return { connectors: [structuredClone(NOTION)] }
      case '/v1/connectors/update':
        return {
          connector: {
            ...NOTION,
            tools: [{ ...NOTION.tools[0], permission: 'allow' }],
          },
        }
      case '/v1/threads/approve':
        return approve(input)
      default:
        throw new Error(`Unexpected ${path}`)
    }
  })
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
})

const posted = (path: string) =>
  client.post.mock.calls.filter(([called]) => called === path)

const answerOf = (approved: boolean) => [
  '/v1/threads/approve',
  {
    key: KEY,
    threadId: THREAD_ID,
    runId: RUN_ID,
    approvalId: APPROVAL_ID,
    approved,
  },
  expect.any(AbortSignal),
]

// Opens the chat while its reply waits for the user to approve its call.
async function openWaiting() {
  let settle!: (approved: boolean) => void
  followRun(
    new Promise((resolve) => {
      settle = resolve
    }),
  )
  render(<ChatInterface initialChatId={THREAD_ID} />)
  const card = await screen.findByRole('group', {
    name: 'Notion wants to run Create a page',
  })
  expect(within(card).getByText(/"title": "Plans"/)).toBeInTheDocument()
  return { card, settle }
}

describe('a reply that asks to run a connector’s tool', () => {
  it.each([
    ['Allow once', true, 'Saved your plans.'],
    ['Decline', false, 'I left your plans alone.'],
  ])(
    '%s answers the run, and the reply goes on',
    async (choice, approved, reply) => {
      const { card, settle } = await openWaiting()

      await act(async () =>
        fireEvent.click(within(card).getByRole('button', { name: choice })),
      )

      expect(posted('/v1/threads/approve')).toEqual([answerOf(approved)])
      expect(posted('/v1/connectors/update')).toEqual([])
      await act(async () => settle(approved))
      expect(await screen.findAllByText(reply)).not.toHaveLength(0)
      expect(
        screen.queryByRole('group', {
          name: 'Notion wants to run Create a page',
        }),
      ).toBeNull()
    },
  )

  it('Always allow answers the run, then stops asking for the tool', async () => {
    const { card, settle } = await openWaiting()

    await act(async () =>
      fireEvent.click(
        within(card).getByRole('button', { name: 'Always allow' }),
      ),
    )

    await waitFor(() =>
      expect(posted('/v1/connectors/update')).toEqual([
        [
          '/v1/connectors/update',
          { key: KEY, id: NOTION.id, tools: { create_page: 'allow' } },
          expect.any(AbortSignal),
        ],
      ]),
    )
    expect(posted('/v1/threads/approve')).toEqual([answerOf(true)])
    const calls = client.post.mock.calls.map(([path]) => path)
    expect(calls.indexOf('/v1/threads/approve')).toBeLessThan(
      calls.indexOf('/v1/connectors/update'),
    )
    await act(async () => settle(true))
  })

  it('takes no second answer while the first is sent, and says nothing of one already taken', async () => {
    let refuse!: (cause: unknown) => void
    approve = () =>
      new Promise((_, reject) => {
        refuse = reject
      })
    const { card, settle } = await openWaiting()

    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Allow once' })),
    )
    expect(within(card).getByRole('button', { name: 'Decline' })).toBeDisabled()
    await act(async () =>
      refuse(
        new HarnessError({
          code: 'REVISION_CONFLICT',
          action: 'reload',
          message: 'The action was already answered',
        }),
      ),
    )

    expect(posted('/v1/threads/approve')).toEqual([answerOf(true)])
    expect(within(card).queryByRole('alert')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Decline' })).toBeDisabled()
    await act(async () => settle(true))
  })
})
