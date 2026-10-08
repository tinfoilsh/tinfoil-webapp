import { ChatMessages } from '@/components/chat/chat-messages'
import type { MessageRenderProps } from '@/components/chat/renderers/types'
import {
  DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  type BaseModel,
} from '@/config/models'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFindContextStartIndex = vi.hoisted(() => vi.fn(() => 0))
const mockRenderMessage = vi.hoisted(() =>
  vi.fn<(props: MessageRenderProps) => void>(),
)

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: (props: MessageRenderProps) => {
        mockRenderMessage(props)
        const { message, isStreaming, isLastMessage, hideActions } = props
        return (
          <div
            data-testid={`message-${message.turnId}`}
            data-streaming={isStreaming}
            data-last={isLastMessage}
            data-actions-hidden={hideActions}
          >
            {message.role}: {message.content}
          </div>
        )
      },
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

const models: BaseModel[] = [
  {
    modelName: 'gpt-oss-120b',
    name: 'GPT-OSS',
    nameShort: 'GPT-OSS',
    image: '',
    description: '',
    type: 'chat',
    chat: true,
    chatConfig: { contextWindowTokens: 1000 },
  },
]

const baseProps = {
  messages,
  pendingRecoveries: [recovery],
  isDarkMode: false,
  chatId: 'chat-1',
  models,
  selectedModel: models[0].modelName,
  autoIntelligence: DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  setAutoIntelligence: () => {
    throw new Error('Unexpected intelligence change while rendering messages')
  },
} satisfies ComponentProps<typeof ChatMessages>

describe('ChatMessages recovery indicator', () => {
  beforeEach(() => {
    mockFindContextStartIndex.mockReturnValue(0)
    mockRenderMessage.mockClear()
  })

  it('hides message actions when the conversation is read-only', () => {
    const actions = {
      onEditMessage: vi.fn(),
      onRegenerateMessage: vi.fn(),
      onDeleteMessage: vi.fn(),
      onEditAssistantMessage: vi.fn(),
      onContinueAssistantMessage: vi.fn(),
      onForkMessage: vi.fn(),
      onRetryToolCall: vi.fn(async () => true),
    }
    const { rerender } = render(<ChatMessages {...baseProps} {...actions} />)
    expect(mockRenderMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...actions,
        hideActions: false,
      }),
    )

    rerender(<ChatMessages {...baseProps} {...actions} readOnly />)

    expect(screen.getByTestId('message-turn-1')).toHaveAttribute(
      'data-actions-hidden',
      'true',
    )
    expect(mockRenderMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hideActions: true,
        onEditMessage: undefined,
        onRegenerateMessage: undefined,
        onDeleteMessage: undefined,
        onEditAssistantMessage: undefined,
        onContinueAssistantMessage: undefined,
        onForkMessage: undefined,
        onRetryToolCall: undefined,
      }),
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

    expect(
      screen.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument()

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

    expect(userMessage.closest('[data-message-role]')?.nextElementSibling).toBe(
      indicator,
    )
    expect(indicator.closest('[data-message-role]')).toBeNull()
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
    expect(
      renderedMessages[0].closest('[data-message-role]')?.nextElementSibling,
    ).toBe(renderedMessages[1].closest('[data-message-role]'))
    expect(renderedMessages[1]).toHaveAttribute('data-streaming', 'true')
    expect(renderedMessages[1]).toHaveAttribute('data-last', 'true')
    expect(screen.getByText('assistant: Partial answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: /Recovering stream/ }),
    ).not.toBeInTheDocument()
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
    expect(assistant).toHaveTextContent('assistant: Recovered so far')
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
    expect(assistant.closest('[data-message-role]')?.nextElementSibling).toBe(
      screen.getByRole('status', { name: /Recovering stream/ }),
    )
  })
})
