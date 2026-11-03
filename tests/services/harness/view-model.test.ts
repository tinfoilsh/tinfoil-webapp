import type { Message } from '@/services/harness/types'
import {
  compactionViews,
  messageView,
  shownMessages,
  type ShownMessage,
} from '@/services/harness/view-model'
import { describe, expect, it } from 'vitest'

// A reply with the steps a later harness may store.
const reply = (timeline: ShownMessage['timeline']): ShownMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: '2026-10-28T09:00:00Z',
  timeline,
})

describe('a message holding values a later harness may send', () => {
  it('leaves out a block of a type this client does not know', () => {
    const view = messageView(
      reply([
        {
          id: 'card',
          type: 'citation_card',
          name: 'web_search',
          display: { query: 'later', status: 'completed', sources: [] },
        },
        { id: 'c', type: 'content', content: 'Answer.' },
      ]),
    )

    expect(view.timeline).toEqual([
      { id: 'c', type: 'content', content: 'Answer.' },
    ])
  })

  it.each([
    ['while its reply streams', true],
    ['once its reply stopped', false],
  ])(
    'shows a tool status this client does not know as completed %s',
    (_, streaming) => {
      const view = messageView(
        reply([
          {
            id: 's',
            type: 'tool_call',
            toolCallId: 's',
            name: 'web_search',
            arguments: '{"query":"trip"}',
            display: { query: 'trip', status: 'paused', sources: [] },
          },
          {
            id: 'f',
            type: 'tool_call',
            toolCallId: 'f',
            name: 'web_fetch',
            arguments: '{"url":"https://tinfoil.sh/"}',
            display: {
              url: 'https://tinfoil.sh/',
              status: 'paused',
              sources: [],
            },
          },
        ]),
        streaming,
      )

      expect(view.timeline).toEqual([
        {
          type: 'web_search',
          id: 's',
          state: { query: 'trip', status: 'completed', sources: [] },
        },
        {
          type: 'url_fetches',
          id: 'f',
          fetches: [
            {
              id: 'f',
              url: 'https://tinfoil.sh/',
              status: 'completed',
              sources: [],
            },
          ],
        },
      ])
    },
  )

  it('shows an attachment of a kind this client does not know as a file', () => {
    const view = messageView({
      id: 'u1',
      role: 'user',
      createdAt: '2026-10-28T09:00:00Z',
      content: 'Watch this.',
      attachments: [
        {
          id: 'v1',
          kind: 'video',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          size: 2048,
        },
      ],
    })

    expect(view.attachments).toEqual([
      {
        id: 'v1',
        type: 'document',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: 2048,
      },
    ])
  })
})

describe('the compaction markers of a chat', () => {
  const question = (id: string): Message => ({
    id,
    role: 'user',
    createdAt: '2026-10-28T09:00:00Z',
    content: id,
  })
  const answer = (id: string): Message => ({
    id,
    role: 'assistant',
    createdAt: '2026-10-28T09:00:01Z',
    timeline: [{ id: `${id}-text`, type: 'content', content: id }],
  })
  const messages: Message[] = [
    question('u1'),
    answer('a1'),
    {
      id: 'c1',
      role: 'compaction',
      createdAt: '2026-10-28T09:01:00Z',
      content: '## Goals and context\nA first question.',
      compaction: {
        messages: 2,
        startedAt: 1,
        endedAt: 2,
        model: 'long-summary',
        version: 1,
      },
    },
    question('u2'),
    answer('a2'),
    // A summary a run is still writing, which shows before the next message
    // shown, past one of a role this client does not know.
    { id: 'c2', role: 'compaction', createdAt: '2026-10-28T09:02:00Z' },
    { id: 'n1', role: 'narrator', createdAt: '2026-10-28T09:02:00Z' },
    question('u3'),
  ]
  const summarized = {
    id: 'c1',
    isRunning: false,
    summary: '## Goals and context\nA first question.',
    messageCount: 2,
  }

  it('shows each before the message after it, and leaves them out of the messages the actions name', () => {
    expect(compactionViews(messages, true)).toEqual({
      u2: summarized,
      u3: {
        id: 'c2',
        isRunning: true,
        summary: '',
        messageCount: 0,
        startedAt: Date.parse('2026-10-28T09:02:00Z'),
      },
    })
    expect(shownMessages(messages).map(({ id }) => id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
    ])
  })

  it('shows no summary being written once the run writing it is over', () => {
    expect(compactionViews(messages, false)).toEqual({ u2: summarized })
  })
})
