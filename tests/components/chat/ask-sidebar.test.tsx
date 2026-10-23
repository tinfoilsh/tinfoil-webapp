import { AskSidebar } from '@/components/chat/ask-sidebar'
import { useSidebarChat } from '@/components/chat/hooks/use-sidebar-chat'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { AskContext } from '@/services/harness/thread-store'
import { act, render, screen, within } from '@testing-library/react'
import { beforeAll, expect, it } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'

beforeAll(() => initializeRenderers())

// Longer than the quote preview shows before "Show more".
const QUOTE = `${'The selected passage goes on. '.repeat(10)}End.`
const PREVIEW = `${QUOTE.slice(0, 240).trimEnd()}…`

function renderAsk(context: () => Promise<AskContext>) {
  let ask!: (text: string) => void
  function Ask() {
    const state = useSidebarChat({ context, options: {} })
    ask = state.askQuote
    return (
      <AskSidebar
        isOpen
        onClose={() => {}}
        state={state}
        models={testSession.models}
        selectedModel="test-model"
        isDarkMode={false}
      />
    )
  }
  render(<Ask />)
  return (text: string) => act(() => ask(text))
}

const buttonsIn = (element: HTMLElement) =>
  within(element)
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)

it('shows the quoted selection while the answer loads and keeps it a quote once the harness returns it', async () => {
  signIn()
  let readContext!: (context: AskContext) => void
  let answer!: () => void
  const answered = new Promise<void>((resolve) => (answer = resolve))
  let snapshotApplied!: () => void
  const applied = new Promise<void>((resolve) => (snapshotApplied = resolve))
  client.events.mockImplementation(async function* () {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: 'ask-thread', runId: 'ask-run' },
    }
    // The harness keeps an ask's quote as its message's content.
    yield {
      id: 1,
      event: {
        type: 'MESSAGES_SNAPSHOT',
        messages: [
          {
            id: 'question',
            role: 'user',
            content: QUOTE,
            quote: '',
            createdAt: '2026-05-01T10:00:00Z',
          },
        ],
        hasOlder: false,
      },
    }
    // The stream resumes once the view applied the snapshot.
    snapshotApplied()
    await answered
    yield {
      id: 2,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: 'It means this.',
        timestamp: '2026-05-01T10:00:01Z',
      },
    }
    yield {
      id: 3,
      event: { type: 'RUN_FINISHED', threadId: 'ask-thread', runId: 'ask-run' },
    }
  })
  const ask = renderAsk(
    () => new Promise<AskContext>((resolve) => (readContext = resolve)),
  )

  ask(QUOTE)

  expect(screen.queryByText(/Highlight text in the chat/)).toBeNull()
  let [question] = screen.getAllByRole('article')
  expect(within(question).getByText(PREVIEW)).toBeVisible()
  expect(buttonsIn(question)).toEqual(['Show more'])
  expect(
    screen.getByRole('status', { name: 'Streaming response' }),
  ).toBeVisible()

  await act(async () => {
    readContext({ threadId: 'source', local: true })
    await applied
  })
  expect(client.events).toHaveBeenCalledExactlyOnceWith(
    '/v1/threads/turn',
    expect.objectContaining({ kind: 'ask', content: QUOTE, quote: QUOTE }),
    expect.any(AbortSignal),
  )
  expect(screen.getAllByRole('article')).toHaveLength(1)
  ;[question] = screen.getAllByRole('article')
  expect(within(question).getByText(PREVIEW)).toBeVisible()
  expect(buttonsIn(question)).toEqual(['Show more'])
  expect(
    screen.getByRole('status', { name: 'Streaming response' }),
  ).toBeVisible()

  await act(async () => answer())

  const reply = await screen.findByRole('article', { name: 'Al said' })
  expect(within(reply).getByText('It means this.')).toBeVisible()
  ;[question] = screen.getAllByRole('article')
  expect(question).toHaveAttribute('data-message-role', 'user')
  expect(within(question).getByText(PREVIEW)).toBeVisible()
  expect(buttonsIn(question)).toEqual(['Show more'])
  expect(
    screen.queryByRole('status', { name: 'Streaming response' }),
  ).toBeNull()
})

it('keeps the quoted selection beside the error when the chat cannot be read', async () => {
  signIn()
  const ask = renderAsk(async () => {
    throw new DOMException('The chat database is unavailable', 'UnknownError')
  })

  ask('A short passage')

  const reply = await screen.findByRole('article', { name: 'Al said' })
  expect(
    within(reply).getByText('Error: The chat database is unavailable'),
  ).toBeVisible()
  const [question] = screen.getAllByRole('article')
  expect(question).toHaveAttribute('data-message-role', 'user')
  expect(within(question).getByText('A short passage')).toBeVisible()
  expect(buttonsIn(question)).toEqual([])
  expect(client.events).not.toHaveBeenCalled()
})
