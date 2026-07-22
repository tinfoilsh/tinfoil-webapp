import { ChatMessages } from '@/components/chat/chat-messages'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/config/models', () => ({
  findSelectableModel: (_id: string, models: unknown[]) => models[0],
}))

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: ({
        message,
        isStreaming,
      }: {
        message: { role: string; turnId?: string; content?: string }
        isStreaming?: boolean
      }) => (
        <div
          data-testid={`message-${message.turnId}`}
          data-streaming={isStreaming}
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
  findContextStartIndex: () => 0,
  getContextTokenBudget: () => 1000,
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
  models: [{ id: 'model-1', contextWindow: 1000 }] as any,
  selectedModel: 'model-1',
}

describe('ChatMessages recovery indicator', () => {
  it('renders the recovery widget immediately after its user turn', async () => {
    render(<ChatMessages {...baseProps} />)

    const userMessage = await screen.findByTestId('message-turn-1')
    const indicator = screen.getByRole('status', {
      name: /Recovering response/,
    })

    expect(userMessage.nextElementSibling).toBe(indicator)
    expect(screen.getByText('This may take a few minutes')).toBeInTheDocument()
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
      screen.queryByRole('status', { name: /Recovering response/ }),
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
    expect(screen.getByText('assistant: Partial answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: /Recovering response/ }),
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
  })
})
