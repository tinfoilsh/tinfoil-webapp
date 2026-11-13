import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { initialChat, reduceEvent } from '@tinfoil/chat-client/reducer'
import type { Frame, Message } from '@tinfoil/chat-client/types'
import { createElement } from 'react'
import { afterEach, expect, test } from 'vitest'
import recorded from '../../../harness-protocol/fixtures/browser.json'
import { Conversation, MessageView } from '../src/message-view'

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
    createElement(MessageView, {
      message: reply(),
      streaming: true,
      isDarkMode: false,
    }),
  )
  expect(screen.queryByText(answer.delta)).not.toBeInTheDocument()
  state = reduceEvent(state, frames[textIndex])
  expect(reply().content).toBeUndefined()
  view.rerender(
    createElement(MessageView, {
      message: reply(),
      streaming: true,
      isDarkMode: false,
    }),
  )
  expect(screen.getByText(answer.delta)).toBeVisible()
  for (const frame of frames.slice(textIndex + 1))
    state = reduceEvent(state, frame)
  view.rerender(
    createElement(MessageView, {
      message: reply(),
      streaming: false,
      isDarkMode: false,
    }),
  )
  expect(screen.getAllByText(answer.delta)).toHaveLength(1)
})

const REPLY: Message = {
  id: 'reply',
  role: 'assistant',
  createdAt: '2026-11-13T00:00:00Z',
}
const show = (message: Message, streaming = false) =>
  createElement(MessageView, { message, streaming, isDarkMode: false })

test('timeline text is rendered once between its steps, with a fallback for older plain-text replies', () => {
  const view = render(show({ ...REPLY, content: 'Older plain-text reply' }))
  expect(screen.getByText('Older plain-text reply')).toBeVisible()
  view.rerender(
    show({
      ...REPLY,
      content: 'Duplicate summary',
      modelDisplayName: 'GPT-OSS 120B',
      timeline: [
        { id: 'thinking', type: 'thinking', content: 'Private working notes' },
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
    }),
  )
  expect(screen.queryByText('Older plain-text reply')).not.toBeInTheDocument()
  expect(screen.queryByText('Duplicate summary')).not.toBeInTheDocument()
  expect(screen.getByText('I will read the page.')).toBeVisible()
  expect(
    screen.getAllByText('The page covers investigative journalism.'),
  ).toHaveLength(1)
  expect(screen.getByText('GPT-OSS 120B')).toBeVisible()

  // Each lone step shows as its own row, closed until it is opened.
  expect(screen.queryByText('Private working notes')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Thought' }))
  expect(screen.getByText('Private working notes')).toBeVisible()
  const read = screen.getByRole('button', { name: 'Read the page' })
  expect(read).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(read)
  expect(read).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Public page observation')).toBeInTheDocument()
})

test('a run of thinking and browser steps shows as one row that names the action under way, then what the run did', () => {
  const timeline = [
    { id: 'plan', type: 'thinking', content: 'Find the page', complete: true },
    {
      id: 'go',
      type: 'tool_call',
      name: 'browser_action',
      arguments: '{"action":"navigate","url":"https://www.example.com/tech"}',
      result: { text: 'URL: https://www.example.com/tech' },
    },
    {
      id: 'click',
      type: 'tool_call',
      name: 'browser_action',
      arguments: '{"action":"click","ref":"e4"}',
    },
  ]
  const view = render(show({ ...REPLY, timeline }, true))
  // The row names the action still waiting for its result, and counts how
  // long the run has gone on.
  const [live] = screen.getAllByRole('button')
  expect(live).toHaveAccessibleName(/^Clicking/)
  expect(live).toHaveAttribute('aria-expanded', 'false')
  expect(within(live).getByText('0s')).toBeInTheDocument()

  fireEvent.click(live)
  expect(live).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Thought' })).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Went to example.com' }),
  ).toBeVisible()

  view.rerender(
    show({
      ...REPLY,
      timeline: [
        ...timeline.slice(0, 2),
        {
          ...timeline[2],
          result: {
            text: '{"error":"STALE_ELEMENT","message":"Read the page again."}',
          },
        },
        { id: 'answer', type: 'content', content: 'The link moved.' },
      ],
    }),
  )
  const [done] = screen.getAllByRole('button')
  expect(done).toHaveAccessibleName('Thought and took 2 browser actions')
  expect(within(done).queryByText('0s')).not.toBeInTheDocument()
  // A step the extension refused says why instead of offering its result.
  const failed = screen.getByRole('button', {
    name: 'Clicked — Read the page again.',
  })
  expect(failed).toBeDisabled()
  expect(screen.getByText('The link moved.')).toBeVisible()
})

test('a question shows as the user wrote it', () => {
  render(
    show({
      id: 'question',
      role: 'user',
      createdAt: '2026-11-13T00:00:00Z',
      content: 'Open **the** page\nthen read it',
    }),
  )
  expect(screen.getByText(/Open \*\*the\*\* page/)).toHaveTextContent(
    'Open **the** page then read it',
  )
  expect(screen.queryByText('Encrypted')).not.toBeInTheDocument()
})

test('a chat waits visibly for its reply until the first of it arrives', () => {
  const question: Message = {
    id: 'question',
    role: 'user',
    content: 'Open the news and summarize it',
    createdAt: '2026-11-13T00:00:00Z',
  }
  const conversation = (messages: Message[], busy: boolean) =>
    createElement(Conversation, { messages, busy, isDarkMode: false })
  const waiting = () =>
    screen.queryByRole('status', { name: 'Waiting for response' })
  // A question that has not been sent to a run, or whose run was stopped,
  // waits for nothing.
  const view = render(conversation([question], false))
  expect(waiting()).not.toBeInTheDocument()
  view.rerender(conversation([question], true))
  expect(waiting()).toBeVisible()

  // The reply shows its own progress from its first block on.
  view.rerender(conversation([question, { ...REPLY, timeline: [] }], true))
  expect(waiting()).not.toBeInTheDocument()
  expect(
    screen.getByRole('status', { name: 'Streaming response' }),
  ).toBeVisible()
})
