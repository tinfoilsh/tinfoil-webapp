import type { Frame, Session, Thread, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_SECRET,
  client,
  signIn,
  testSession,
} from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from './thread-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const THREAD_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const researching: Session = {
  ...testSession,
  features: { ...testSession.features, research: true },
}

const stored: Thread = {
  id: THREAD_ID,
  title: 'Lighthouses',
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
  messageCount: 2,
  activeRun: null,
  hasOlder: false,
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'Tell me about lighthouses.',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:01Z',
      timeline: [{ id: 'c1', type: 'content', content: 'They guide ships.' }],
    },
  ],
}

// A run that replies, and commits the reply as a research's when it is one.
function reply(id: string, research = false) {
  return async function* (): AsyncGenerator<Frame> {
    const events: Frame['event'][] = [
      {
        type: 'RUN_STARTED',
        threadId: THREAD_ID,
        runId: `run-${id}`,
        instance: 'instance-1',
      },
      { type: 'MESSAGES_SNAPSHOT', messages: stored.messages, hasOlder: false },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: id,
        role: 'assistant',
        delta: 'Answered.',
      },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: `run-${id}`,
        metadata: {
          messages: [{ id, ...(research ? { research: { version: 1 } } : {}) }],
        },
      },
    ]
    for (const [index, event] of events.entries()) yield { id: index, event }
  }
}

const turn = (call: number) => client.events.mock.calls[call][1] as Turn
const options = { model: 'test-model', webSearch: true }
// What a turn sends of those options: this browser's prompt cache secret
// joins them.
const sent = { ...options, cacheSecret: CACHE_SECRET }

async function openCloud(session: Session) {
  signIn({ cloud: true, session })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return structuredClone(session)
    if (path === '/v1/threads/get') return structuredClone(stored)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  const hook = renderHook(() => useThread(THREAD_ID, null))
  await waitFor(() => expect(hook.result.current.chat.messages).toHaveLength(2))
  return hook
}

resetChatStoresAroundEachTest()

describe('deep research', () => {
  it('researches the open chat’s questions until a research answers one', async () => {
    const hook = await openCloud(researching)
    act(() => hook.result.current.setResearch(true))

    // A reply that only asks what the research needs to know leaves it on
    // for the answers.
    client.events.mockImplementationOnce(reply('msg_asked'))
    await act(async () => {
      await hook.result.current.send({ content: 'Which coast?', options })
    })
    expect(turn(0).options).toEqual({ ...sent, research: true })
    expect(hook.result.current.research).toBe(true)

    client.events.mockImplementationOnce(reply('msg_report', true))
    await act(async () => {
      await hook.result.current.send({ content: 'Maine.', options })
    })
    expect(turn(1).options).toEqual({ ...sent, research: true })
    expect(hook.result.current.research).toBe(false)

    client.events.mockImplementationOnce(reply('msg_thanks'))
    await act(async () => {
      await hook.result.current.send({ content: 'Thanks.', options })
    })
    expect(turn(2).options).toEqual(sent)
  })

  it('never has a turn research that does not answer a question anew', async () => {
    const hook = await openCloud(researching)
    act(() => hook.result.current.setResearch(true))

    client.events.mockImplementationOnce(reply('a1'))
    await act(async () => {
      await hook.result.current.continueReply(1, { options })
    })
    expect(turn(0)).toMatchObject({ kind: 'continue', options })
    expect(turn(0).options).not.toHaveProperty('research')
    expect(hook.result.current.research).toBe(true)
  })

  it('researches nothing while the session does not offer it', async () => {
    const hook = await openCloud(testSession)
    act(() => hook.result.current.setResearch(true))

    client.events.mockImplementationOnce(reply('msg_answer'))
    await act(async () => {
      await hook.result.current.send({ content: 'Lighthouses?', options })
    })
    expect(turn(0).options).toEqual(sent)
  })
})
