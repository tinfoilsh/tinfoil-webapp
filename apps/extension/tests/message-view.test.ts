import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { initialChat, reduceEvent } from '@tinfoil/chat-client/reducer'
import type { Frame, Message } from '@tinfoil/chat-client/types'
import { createElement } from 'react'
import { afterEach, expect, test } from 'vitest'
import recorded from '../../../harness-protocol/fixtures/browser.json'
import { MessageView } from '../src/message-view'

afterEach(cleanup)

test('a recorded browser run displays the streamed answer and its completed snapshot', () => {
  const frames = recorded.frames as Frame[]
  const textIndex = frames.findIndex(
    (frame) => frame.event.type === 'TEXT_MESSAGE_CHUNK',
  )
  expect(textIndex).toBeGreaterThan(-1)
  const answer = frames[textIndex].event
  if (answer.type !== 'TEXT_MESSAGE_CHUNK')
    throw new Error('Missing recorded answer')
  let state = frames
    .slice(0, textIndex)
    .reduce((current, frame) => reduceEvent(current, frame), initialChat())
  const reply = () => {
    const message = state.messages.find(
      (message) => message.id === answer.messageId,
    )
    if (!message) throw new Error('Missing assistant reply')
    return message
  }
  const view = render(
    createElement(MessageView, { message: reply(), streaming: true }),
  )
  expect(screen.queryByText(answer.delta)).not.toBeInTheDocument()
  state = reduceEvent(state, frames[textIndex])
  expect(reply().content).toBeUndefined()
  view.rerender(
    createElement(MessageView, { message: reply(), streaming: true }),
  )
  expect(screen.getByText(answer.delta)).toBeVisible()
  for (const frame of frames.slice(textIndex + 1))
    state = reduceEvent(state, frame)
  view.rerender(
    createElement(MessageView, { message: reply(), streaming: false }),
  )
  expect(screen.getAllByText(answer.delta)).toHaveLength(1)
})

test('timeline text is rendered once across tools, with a fallback for older plain-text replies', () => {
  const message: Message = {
    id: 'reply',
    role: 'assistant',
    createdAt: '2026-11-13T00:00:00Z',
    content: 'Older plain-text reply',
  }
  const view = render(createElement(MessageView, { message, streaming: false }))
  expect(screen.getByText('Older plain-text reply')).toBeVisible()
  view.rerender(
    createElement(MessageView, {
      message: {
        ...message,
        content: 'Duplicate summary',
        timeline: [
          {
            id: 'thinking',
            type: 'thinking',
            content: 'Private working notes',
          },
          { id: 'before', type: 'content', content: 'I will read the page.' },
          {
            id: 'read',
            type: 'tool_call',
            name: 'browser_action',
            arguments: '{"action":"read"}',
            result: { text: 'Public page observation' },
          },
          {
            id: 'after',
            type: 'content',
            content: '**The page covers investigative journalism.**',
          },
        ],
      },
      streaming: false,
    }),
  )
  expect(screen.queryByText('Older plain-text reply')).not.toBeInTheDocument()
  expect(screen.queryByText('Duplicate summary')).not.toBeInTheDocument()
  expect(screen.queryByText('Private working notes')).not.toBeInTheDocument()
  expect(screen.getByText('I will read the page.')).toBeVisible()
  expect(
    screen.getAllByText('The page covers investigative journalism.'),
  ).toHaveLength(1)
})
