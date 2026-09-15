import { initialChat, reduceEvent } from '@/services/harness/reducer'
import type { Message } from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { expect, it } from 'vitest'

const message: Message = {
  id: 'm',
  role: 'assistant',
  createdAt: '2026-09-15T04:35:38Z',
  timeline: [
    { id: 'thinking-1', type: 'thinking', content: 'Respond briefly' },
    { id: 'content-1', type: 'content', content: 'Hey' },
    { id: 'thinking-2', type: 'thinking', content: '.' },
    { id: 'content-2', type: 'content', content: ', I am here.' },
  ],
}

it('groups interleaved reasoning and answer text in saved messages', () => {
  const original = structuredClone(message)
  const view = messageView(message)

  expect(view.timeline).toEqual([
    {
      id: 'thinking-1',
      type: 'thinking',
      content: 'Respond briefly.',
      isThinking: false,
    },
    { id: 'content-1', type: 'content', content: 'Hey, I am here.' },
  ])
  expect(view.content).toBe('Hey, I am here.')
  expect(message).toEqual(original)
})

it('keeps one reasoning section as late reasoning arrives during an answer', () => {
  let state = initialChat()
  for (const block of message.timeline!) {
    state = reduceEvent(state, {
      event: {
        type:
          block.type === 'thinking'
            ? 'REASONING_MESSAGE_CHUNK'
            : 'TEXT_MESSAGE_CHUNK',
        messageId: block.type === 'thinking' ? 'm-reasoning' : 'm',
        delta: block.content,
      },
    })
    expect(
      messageView(state.messages[0], true).timeline?.filter(
        (item) => item.type === 'thinking',
      ),
    ).toHaveLength(1)
  }
  expect(messageView(state.messages[0], true).timeline).toMatchObject([
    { type: 'thinking', content: 'Respond briefly.', isThinking: true },
    { type: 'content', content: 'Hey, I am here.' },
  ])
  state = reduceEvent(state, { event: { type: 'RUN_FINISHED' } })
  expect(messageView(state.messages[0]).timeline?.[0]).toMatchObject({
    type: 'thinking',
    content: 'Respond briefly.',
    isThinking: false,
  })
})

it('keeps tool calls between the corresponding answer sections', () => {
  const view = messageView({
    ...message,
    timeline: [
      { id: 'c1', type: 'content', content: 'Before.' },
      { id: 't1', type: 'thinking', content: 'First. ' },
      {
        id: 'tool',
        type: 'tool_call',
        toolCallId: 'tool',
        name: 'web_search',
        arguments: '{"query":"example"}',
        result: 'Result',
      },
      { id: 't2', type: 'thinking', content: 'Second.' },
      { id: 'c2', type: 'content', content: 'After.' },
    ],
  })
  expect(view.timeline).toMatchObject([
    { id: 't1', type: 'thinking', content: 'First. Second.' },
    { id: 'c1', type: 'content', content: 'Before.' },
    {
      id: 'tool',
      type: 'tool_call',
      name: 'web_search',
      arguments: '{"query":"example"}',
      result: 'Result',
    },
    { id: 'c2', type: 'content', content: 'After.' },
  ])
})
