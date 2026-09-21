import { ChatMessages } from '@/components/chat/chat-messages'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFindContextStartIndex = vi.hoisted(() => vi.fn(() => 0))

vi.mock('@/config/models', () => ({
  findSelectableModel: (_id: string, models: unknown[]) => models[0],
}))

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: ({
        message,
        isStreaming,
        isLastMessage,
        hideActions,
      }: {
        message: { role: string; turnId?: string; content?: string }
        isStreaming?: boolean
        isLastMessage?: boolean
        hideActions?: boolean
      }) => (
        <div
          data-testid={`message-${message.turnId}`}
          data-streaming={isStreaming}
          data-last={isLastMessage}
          data-actions-hidden={hideActions}
        >
          {message.role}: {message.content}
        </div>
      ),
    }),
  }),
}))

vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

vi.mock('@/hooks/use-chat-print', () => ({
  useChatPrint: () => undefined,
}))

vi.mock('@/utils/token-estimation', () => ({
  findContextStartIndex: mockFindContextStartIndex,
  getContextTokenBudget: () => 1000,
  getHistoryTokenBudget: () => 1000,
  resolveContextWindowTokens: () => 1000,
}))

vi.mock('@/components/chat/PrintableChat', () => ({
  PrintableChat: () => null,
}))

const recovery = {
  v: 1 as const,
  turnId: 'turn-1',
  keyId: '0'.repeat(32),
  createdAt: '2026-07-21T00:00:00.000Z',
  expiresAt: '2026-07-22T00:00:00.000Z',
  nonce: 'nonce',
  ciphertext: 'ciphertext',
}

const messages = [
  {
    role: 'user' as const,
    turnId: 'turn-1',
    content: 'Question',
    timestamp: new Date('2026-07-21T00:00:00.000Z'),
  },
]

const baseProps = {
  messages,
  pendingRecoveries: [recovery],
  isDarkMode: false,
  chatId: 'chat-1',
  models: [{ id: 'model-1', chatConfig: { contextWindowTokens: 1000 } }] as any,
  selectedModel: 'model-1',
}

describe('ChatMessages recovery indicator', () => {
  beforeEach(() => {
    mockFindContextStartIndex.mockReturnValue(0)
  })

  it('hides message actions when the conversation is read-only', () => {
    render(<ChatMessages {...baseProps} hideMessageActions />)

    expect(screen.getByTestId('message-turn-1')).toHaveAttribute(
      'data-actions-hidden',
      'true',
    )
  })

  it('defers archived message rendering until requested', () => {
    mockFindContextStartIndex.mockReturnValue(2)
    const archivedMessages = [
      { ...messages[0], turnId: 'archived-1', content: 'First' },
      {
        ...messages[0],
        turnId: 'archived-2',
        content: 'Second',
        timestamp: new Date('2026-07-21T00:00:00.001Z'),
      },
      { ...messages[0], turnId: 'live', content: 'Latest' },
    ]

    render(
      <ChatMessages
        {...baseProps}
        messages={archivedMessages}
        pendingRecoveries={[]}
      />,
    )

    expect(screen.queryByTestId('message-archived-1')).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show 2 earlier messages' }),
    )
    expect(screen.getByTestId('message-archived-1')).toBeInTheDocument()
  })

  it('keeps an archived recovering turn visible', () => {
    mockFindContextStartIndex.mockReturnValue(1)
    render(
      <ChatMessages
        {...baseProps}
        messages={[
          messages[0],
          {
            role: 'user',
            turnId: 'turn-2',
            content: 'Latest',
            timestamp: new Date('2026-07-21T00:00:01.000Z'),
          },
        ]}
        activeRecoveryTurnIds={['turn-1']}
      />,
    )

    expect(screen.getByTestId('message-turn-1')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps the archive expanded after an archived recovery completes', () => {
    mockFindContextStartIndex.mockReturnValue(1)
    const latestMessage = {
      role: 'user' as const,
      turnId: 'turn-2',
      content: 'Latest',
      timestamp: new Date('2026-07-21T00:00:01.000Z'),
    }

    const { rerender } = render(
      <ChatMessages
        {...baseProps}
        messages={[messages[0], latestMessage]}
        activeRecoveryTurnIds={['turn-1']}
      />,
    )

    expect(screen.getByTestId('message-turn-1')).toBeInTheDocument()

    // Recovery completes: the envelope clears and the recovered assistant
    // message lands in the archived slice.
    mockFindContextStartIndex.mockReturnValue(2)
    rerender(
      <ChatMessages
        {...baseProps}
        messages={[
          messages[0],
          {
            role: 'assistant',
            turnId: 'turn-1',
            content: 'Recovered answer',
            timestamp: new Date('2026-07-21T00:00:00.500Z'),
          },
          latestMessage,
        ]}
        pendingRecoveries={[]}
      />,
    )

    expect(screen.getByText('user: Question')).toBeInTheDocument()
    expect(screen.getByText('assistant: Recovered answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps a never-started archived recovery collapsed', () => {
    mockFindContextStartIndex.mockReturnValue(1)

    render(
      <ChatMessages
        {...baseProps}
        messages={[
          messages[0],
          {
            role: 'user',
            turnId: 'turn-2',
            content: 'Latest',
            timestamp: new Date('2026-07-21T00:00:01.000Z'),
          },
        ]}
      />,
    )

    expect(screen.queryByTestId('message-turn-1')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Show 1 earlier messages' }),
    ).toBeInTheDocument()
  })

  it('renders the recovery widget immediately after its user turn', async () => {
    render(<ChatMessages {...baseProps} />)

    const userMessage = await screen.findByTestId('message-turn-1')
    const indicator = screen.getByRole('status', {
      name: /Recovering stream/,
    })

    expect(userMessage.nextElementSibling).toBe(indicator)
    expect(screen.getByText('Recovering stream...')).toBeInTheDocument()
    expect(
      screen.queryByText('Catching up to the live response'),
    ).not.toBeInTheDocument()
    expect(indicator).toHaveClass('-mt-6')
    expect(indicator.firstElementChild).not.toHaveClass('border')
    expect(indicator.firstElementChild).not.toHaveClass('bg-surface-chat')
  })

  it('hides the widget for the actively streaming turn', async () => {
    render(
      <ChatMessages {...baseProps} isWaitingForResponse isStreamingResponse />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('message-turn-1')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('status', { name: /Recovering stream/ }),
    ).not.toBeInTheDocument()
  })

  it('ignores an active recovery after its pending envelope is removed', () => {
    render(
      <ChatMessages
        {...baseProps}
        pendingRecoveries={[]}
        activeRecoveryTurnIds={['turn-1']}
      />,
    )

    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false')
    expect(
      screen.queryByRole('status', { name: /Recovering stream/ }),
    ).not.toBeInTheDocument()
  })

  it('replaces the recovery widget with a progressive draft', async () => {
    render(
      <ChatMessages
        {...baseProps}
        recoveryDrafts={[
          {
            turnId: 'turn-1',
            message: {
              role: 'assistant',
              turnId: 'turn-1',
              content: 'Partial answer',
              timestamp: new Date('2026-07-21T00:00:01.000Z'),
            },
          },
        ]}
      />,
    )

    const renderedMessages = await screen.findAllByTestId('message-turn-1')
    expect(renderedMessages).toHaveLength(2)
    expect(renderedMessages[0].nextElementSibling).toBe(renderedMessages[1])
    expect(renderedMessages[1]).toHaveAttribute('data-streaming', 'true')
    expect(renderedMessages[1]).toHaveAttribute('data-last', 'true')
    expect(screen.getByText('assistant: Partial answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: /Recovering stream/ }),
    ).not.toBeInTheDocument()
  })

  it('renders the progressive draft while the recovered turn is active', async () => {
    render(
      <ChatMessages
        {...baseProps}
        isStreamingResponse
        activeRecoveryTurnIds={['turn-1']}
        recoveryDrafts={[
          {
            turnId: 'turn-1',
            message: {
              role: 'assistant',
              turnId: 'turn-1',
              content: 'Live recovered answer',
              timestamp: new Date('2026-07-21T00:00:01.000Z'),
            },
          },
        ]}
      />,
    )

    expect(
      await screen.findByText('assistant: Live recovered answer'),
    ).toBeInTheDocument()
  })

  it('streams replayed events without a separate catch-up state', async () => {
    render(
      <ChatMessages
        {...baseProps}
        isStreamingResponse
        activeRecoveryTurnIds={['turn-1']}
        recoveryDrafts={[
          {
            turnId: 'turn-1',
            message: {
              role: 'assistant',
              turnId: 'turn-1',
              content: 'Recovered so far',
              timestamp: new Date('2026-07-21T00:00:01.000Z'),
            },
          },
        ]}
      />,
    )

    const assistant = (await screen.findAllByTestId('message-turn-1'))[1]
    expect(assistant).toHaveAttribute('data-streaming', 'true')
    expect(assistant).toHaveAttribute('data-actions-hidden', 'false')
    expect(
      screen.queryByRole('status', { name: /Recovering stream/ }),
    ).not.toBeInTheDocument()
  })

  it('substitutes a progressive draft for a persisted partial response', async () => {
    render(
      <ChatMessages
        {...baseProps}
        messages={[
          ...messages,
          {
            role: 'assistant',
            turnId: 'turn-1',
            content: 'Persisted partial',
            timestamp: new Date('2026-07-21T00:00:01.000Z'),
          },
        ]}
        recoveryDrafts={[
          {
            turnId: 'turn-1',
            message: {
              role: 'assistant',
              turnId: 'turn-1',
              content: 'New streamed partial',
              timestamp: new Date('2026-07-21T00:00:02.000Z'),
            },
          },
        ]}
      />,
    )

    expect(await screen.findAllByTestId('message-turn-1')).toHaveLength(2)
    expect(
      screen.getByText('assistant: New streamed partial'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Persisted partial/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('message-turn-1')[1]).toHaveAttribute(
      'data-last',
      'true',
    )
  })

  it('keeps recovery status visible beside a persisted partial', async () => {
    render(
      <ChatMessages
        {...baseProps}
        messages={[
          ...messages,
          {
            role: 'assistant',
            turnId: 'turn-1',
            content: 'Persisted partial',
            timestamp: new Date('2026-07-21T00:00:01.000Z'),
          },
        ]}
      />,
    )

    const assistant = screen.getAllByTestId('message-turn-1')[1]
    expect(assistant.nextElementSibling).toBe(
      screen.getByRole('status', { name: /Recovering stream/ }),
    )
  })
})
