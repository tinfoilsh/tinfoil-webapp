import type { TimelineToolCallBlock } from '@/components/chat/types'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type {
  Frame,
  Message,
  SavedAnswers,
  Thread,
  ThreadMessage,
  Turn,
} from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const THREAD_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const session = { ...testSession, widgets: ['render_questions'] }

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

// A chat whose reply asks the quiz, answered as given.
const quiz = (answers?: SavedAnswers): ThreadMessage[] => [
  {
    id: 'u1',
    role: 'user',
    createdAt: '2026-04-01T09:00:00Z',
    content: 'quiz me',
  },
  {
    id: 'a1',
    role: 'assistant',
    createdAt: '2026-04-01T09:00:01Z',
    content: 'Here you go.',
    timeline: [
      { id: 'text', type: 'content', content: 'Here you go.' },
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
  },
]

const wire = (message: ThreadMessage): Message =>
  message.role === 'assistant'
    ? {
        id: message.id,
        role: 'assistant',
        createdAt: message.createdAt,
        timeline: message.timeline,
      }
    : {
        id: message.id,
        role: 'user',
        createdAt: message.createdAt,
        content: message.content,
      }

function cloudThread(messages: ThreadMessage[]): Thread {
  return {
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
    messages: messages.map(wire),
  }
}

// A run that answers the question its turn sent.
function answeredRun(window: Message[]) {
  return async function* (): AsyncGenerator<Frame> {
    const events: Frame['event'][] = [
      {
        type: 'RUN_STARTED',
        threadId: THREAD_ID,
        runId: 'run-1',
        instance: 'instance-1',
      },
      { type: 'MESSAGES_SNAPSHOT', messages: window, hasOlder: false },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'msg_graded',
        role: 'assistant',
        delta: 'Both right.',
      },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: 'run-1',
        metadata: {},
      },
    ]
    for (const [id, event] of events.entries()) yield { id, event }
  }
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn
const posted = (path: string) =>
  client.post.mock.calls
    .filter(([called]) => called === path)
    .map(([, input]) => input)
const saveOf = (answers: Record<string, string[] | null>) => ({
  key: KEY,
  threadId: THREAD_ID,
  messageId: 'a1',
  toolCallId: 'quiz',
  answers,
})

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useThread>, void>>

// The answers the open chat shows in the quiz.
const shownAnswers = ({ result }: Hook) =>
  (
    result.current.chat.messages[1].timeline?.find(
      (block) => block.type === 'tool_call',
    ) as TimelineToolCallBlock | undefined
  )?.answers

// Opens the stored quiz. The harness answers each save of answers with the
// next of `saves`, held until the test settles it.
async function openCloud(stored: () => Thread = () => cloudThread(quiz())) {
  signIn({ cloud: true, session })
  const saves: {
    resolve: (thread: Thread) => void
    reject: (cause: unknown) => void
  }[] = []
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return stored()
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/messages/answer')
      return new Promise((resolve, reject) => saves.push({ resolve, reject }))
    throw new Error(`Unexpected ${path}`)
  })
  const hook = renderHook(() => useThread(THREAD_ID, null))
  await waitFor(() => expect(hook.result.current.chat.messages).toHaveLength(2))
  return { hook, saves }
}

resetChatStoresAroundEachTest()

describe('answering the questions of a stored chat', () => {
  it('saves picks made during a save together in the next, and keeps showing them', async () => {
    const { hook, saves } = await openCloud()

    act(() => {
      void hook.result.current.answerQuestions('a1', 'quiz', { q1: ['b'] })
    })
    expect(shownAnswers(hook)).toEqual({ q1: ['b'] })
    expect(hook.result.current.answerSaves).toEqual({ quiz: 'saving' })
    await waitFor(() => expect(saves).toHaveLength(1))
    act(() => {
      void hook.result.current.answerQuestions('a1', 'quiz', { q2: ['x'] })
      void hook.result.current.answerQuestions('a1', 'quiz', { q1: null })
    })
    // The first save's answer knows only its own pick.
    await act(async () => saves[0].resolve(cloudThread(quiz({ q1: ['b'] }))))
    expect(shownAnswers(hook)).toEqual({ q2: ['x'] })
    await waitFor(() => expect(saves).toHaveLength(2))
    await act(async () => saves[1].resolve(cloudThread(quiz({ q2: ['x'] }))))

    expect(posted('/v1/threads/messages/answer')).toEqual([
      saveOf({ q1: ['b'] }),
      saveOf({ q2: ['x'], q1: null }),
    ])
    expect(shownAnswers(hook)).toEqual({ q2: ['x'] })
    expect(hook.result.current.answerSaves).toEqual({})
  })

  it('sends a question only once the answers picked before it are saved', async () => {
    const { hook, saves } = await openCloud()
    act(() => {
      void hook.result.current.answerQuestions('a1', 'quiz', { q1: ['b'] })
    })
    await waitFor(() => expect(saves).toHaveLength(1))
    client.events.mockImplementationOnce(answeredRun(quiz().map(wire)))

    let sending!: Promise<boolean> | undefined
    act(() => {
      sending = hook.result.current.send({ content: '' })
    })
    await act(async () => {})
    expect(client.events).not.toHaveBeenCalled()
    await act(async () => saves[0].resolve(cloudThread(quiz({ q1: ['b'] }))))
    await act(async () => {
      await sending
    })

    expect(client.events).toHaveBeenCalledOnce()
    expect(turn()).toMatchObject({
      kind: 'send',
      content: '',
      threadId: THREAD_ID,
    })
  })

  it('forgets picks the chat no longer offers and shows it as stored', async () => {
    let opened = 0
    const { hook, saves } = await openCloud(() =>
      cloudThread(quiz(opened++ ? { q1: ['a'] } : undefined)),
    )
    let answering!: Promise<void>
    act(() => {
      answering = hook.result.current.answerQuestions('a1', 'quiz', {
        q1: ['b'],
      })
    })
    await waitFor(() => expect(saves).toHaveLength(1))

    await act(async () => {
      saves[0].reject(
        new HarnessError(
          {
            code: 'REVISION_CONFLICT',
            message: 'The question no longer offers that option',
            action: 'reload',
          },
          409,
        ),
      )
      await answering
    })

    expect(shownAnswers(hook)).toEqual({ q1: ['a'] })
    expect(hook.result.current.answerSaves).toEqual({})
    client.events.mockImplementationOnce(answeredRun(quiz().map(wire)))
    await act(() => hook.result.current.send({ content: 'grade me' }))
    expect(posted('/v1/threads/messages/answer')).toHaveLength(1)
  })
})

describe('answering the questions of a chat on this device', () => {
  const localThread = (answers?: SavedAnswers) =>
    storedThread(THREAD_ID, {
      title: 'Quiz',
      titleState: 'generated',
      messages: quiz(answers),
    })

  it('saves the chat the harness answers with, which the next question sends', async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () => localThread())
    const { result } = renderHook(() =>
      useThread(THREAD_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    const answered = { ...localThread({ q2: ['x', 'y'] }), recordVersion: 1 }
    client.post.mockResolvedValueOnce({ thread: answered })

    await act(() =>
      result.current.answerQuestions('a1', 'quiz', { q2: ['x', 'y'] }),
    )

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/messages/answer',
      {
        threadId: THREAD_ID,
        messageId: 'a1',
        toolCallId: 'quiz',
        answers: { q2: ['x', 'y'] },
        local: true,
        thread: localThread(),
      },
      expect.any(AbortSignal),
    )
    expect(await localThreadStore('device').get(THREAD_ID)).toEqual(answered)
    client.events.mockImplementationOnce(answeredRun(quiz().map(wire)))
    await act(() => result.current.send({ content: '' }))
    expect(turn().thread).toEqual(answered)
  })
})
