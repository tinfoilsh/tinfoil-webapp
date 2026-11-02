import { ChatInterface } from '@/components/chat/chat-interface'
import { authTokenManager } from '@/services/auth'
import { HarnessError } from '@/services/harness/sse'
import type {
  AnswerChanges,
  Frame,
  Message,
  SavedAnswers,
  Thread,
  Turn,
} from '@/services/harness/types'
import { resetSafeguards } from '@/services/safeguards'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const QUIZ = JSON.stringify({
  title: 'Driving quiz',
  questions: [
    {
      id: 'q1',
      prompt: 'A red curb means',
      selection: 'single',
      options: [
        { id: 'a', label: 'No stopping' },
        { id: 'b', label: 'Buses only' },
      ],
    },
    {
      id: 'q2',
      prompt: 'Which lights are on at night?',
      selection: 'multiple',
      options: [
        { id: 'x', label: 'Headlights' },
        { id: 'y', label: 'Hazards' },
      ],
    },
  ],
})

const question: Message = {
  id: 'u1',
  role: 'user',
  createdAt: '2026-04-01T09:00:00Z',
  content: 'Quiz me',
}
const reply = (answers?: SavedAnswers): Message => ({
  id: 'a1',
  role: 'assistant',
  createdAt: '2026-04-01T09:00:01Z',
  timeline: [
    { id: 'c1', type: 'content', content: 'Here you go.' },
    {
      id: 'quiz',
      type: 'tool_call',
      toolCallId: 'quiz',
      name: 'render_questions',
      arguments: QUIZ,
      complete: true,
      ...(answers ? { answers } : {}),
    },
  ],
})

const chat = (messages: Message[], fields: Partial<Thread> = {}): Thread => ({
  id: THREAD_ID,
  title: 'Quiz',
  titleState: 'generated',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:01Z',
  activityAt: '2026-04-01T09:00:01Z',
  model: 'test-model',
  projectId: null,
  presetId: null,
  pinned: false,
  webSearchEnabled: true,
  contextUsage: null,
  messageCount: messages.length,
  activeRun: null,
  hasOlder: false,
  messages,
  ...fields,
})

const saveOf = (answers: AnswerChanges) => ({
  key: KEY,
  threadId: THREAD_ID,
  messageId: 'a1',
  toolCallId: 'quiz',
  answers,
})
const saves = () =>
  client.post.mock.calls
    .filter(([path]) => path === '/v1/threads/messages/answer')
    .map(([, input]) => input)

beforeEach(() => {
  authTokenManager.initialize(async () => 'clerk-jwt')
  refuseFetch()
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
})

// Opens the quiz. The harness answers each save of answers with `answer`,
// or with the quiz as the saves so far leave it.
async function openQuiz(
  opened: Thread = chat([question, reply()]),
  answer?: () => Promise<Thread>,
) {
  signIn({ cloud: true })
  let saved: SavedAnswers = {}
  client.post.mockImplementation(async (path: string, input: unknown) => {
    if (path === '/v1/threads/get') return structuredClone(opened)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/messages/answer') {
      if (answer) return answer()
      for (const [id, picked] of Object.entries(
        (input as { answers: AnswerChanges }).answers,
      )) {
        if (picked) saved = { ...saved, [id]: picked }
        else delete saved[id]
      }
      return chat([question, reply(saved)])
    }
    throw new Error(`Unexpected ${path}`)
  })
  render(<ChatInterface initialChatId={THREAD_ID} />)
  await screen.findByText('Driving quiz')
}

const click = (role: 'radio' | 'checkbox' | 'button', name: string) =>
  act(async () => fireEvent.click(screen.getByRole(role, { name })))

describe('answering questions on the chat page', () => {
  it('saves a pick, says when it could not, saves it again, and sends the answers alone', async () => {
    let attempt = 0
    await openQuiz(undefined, async () => {
      if (attempt++ === 0)
        throw new HarnessError(
          {
            code: 'UPSTREAM_REFUSED',
            message: 'A downstream service refused the request',
            action: 'retry',
          },
          502,
        )
      return chat([question, reply({ q1: ['b'] })])
    })

    await click('radio', 'Buses only')
    expect(
      await screen.findByText('Your answers could not be saved.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Buses only' })).toBeChecked()
    await click('button', 'Try again')
    expect(
      await screen.findByText(
        'Saved. Your answers are sent with your next message.',
      ),
    ).toBeInTheDocument()
    expect(saves()).toEqual([saveOf({ q1: ['b'] }), saveOf({ q1: ['b'] })])

    const sent: Message = {
      id: 'u2',
      role: 'user',
      createdAt: '2026-04-01T09:01:00Z',
      content: '',
      answers: [
        {
          toolCallId: 'quiz',
          title: 'Driving quiz',
          questions: [
            {
              id: 'q1',
              prompt: 'A red curb means',
              answered: true,
              selected: [{ id: 'b', label: 'Buses only' }],
            },
            {
              id: 'q2',
              prompt: 'Which lights are on at night?',
              answered: false,
              selected: [],
            },
          ],
        },
      ],
    }
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId: THREAD_ID,
          runId: 'run-1',
          instance: 'instance-1',
        },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [question, reply({ q1: ['b'] }), sent],
          hasOlder: false,
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'a2',
          role: 'assistant',
          delta: 'The first one is wrong.',
        },
        {
          type: 'RUN_FINISHED',
          threadId: THREAD_ID,
          runId: 'run-1',
          metadata: {},
        },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })
    await click('button', 'Submit answers')

    // The reply shows, and the chat announces it.
    expect(
      await screen.findAllByText('The first one is wrong.'),
    ).not.toHaveLength(0)
    expect(client.events.mock.calls[0][1] as Turn).toMatchObject({
      kind: 'send',
      content: '',
      threadId: THREAD_ID,
    })
    expect(screen.getByText('Answered 1 of 2 questions')).toBeInTheDocument()
    expect(screen.getByText('Your answers were sent.')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Submit answers' }),
    ).toBeDisabled()
  })

  it('leaves a question unanswered when its pick is clicked again, and keeps a checklist in order', async () => {
    await openQuiz()

    await click('radio', 'Buses only')
    await waitFor(() => expect(saves()).toHaveLength(1))
    await click('radio', 'Buses only')
    await waitFor(() => expect(saves()).toHaveLength(2))
    await click('checkbox', 'Hazards')
    await waitFor(() => expect(saves()).toHaveLength(3))
    await click('checkbox', 'Headlights')
    await waitFor(() => expect(saves()).toHaveLength(4))

    expect(saves()).toEqual([
      saveOf({ q1: ['b'] }),
      saveOf({ q1: null }),
      saveOf({ q2: ['y'] }),
      saveOf({ q2: ['x', 'y'] }),
    ])
    expect(screen.getByRole('radio', { name: 'Buses only' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Headlights' })).toBeChecked()
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument()
  })

  it('takes no answers in a chat the safeguards flagged', async () => {
    await openQuiz(chat([question, reply({ q1: ['a'] })], { flagged: true }))

    expect(screen.getByRole('radio', { name: 'No stopping' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Buses only' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Submit answers' }),
    ).toBeDisabled()
  })
})
