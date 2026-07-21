import { ChatMessages } from '@/components/chat/chat-messages'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/config/models', () => ({
  findSelectableModel: (_id: string, models: unknown[]) => models[0],
}))

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: ({ message }: { message: { role: string; turnId?: string } }) => (
        <div data-testid={`message-${message.turnId}`}>{message.role}</div>
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
    expect(indicator.firstElementChild).not.toHaveClass(
      'border',
      'bg-surface-chat',
    )
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
})
