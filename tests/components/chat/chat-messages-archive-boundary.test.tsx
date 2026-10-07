import { ChatMessages } from '@/components/chat/chat-messages'
import type { Message } from '@/components/chat/types'
import {
  DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  type BaseModel,
} from '@/config/models'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: ({ message }: { message: Message }) => (
        <div data-testid={`message-${message.turnId}`}>{message.content}</div>
      ),
    }),
  }),
}))

vi.mock('@/hooks/use-chat-print', () => ({
  useChatPrint: () => undefined,
}))

vi.mock('@/components/chat/PrintableChat', () => ({
  PrintableChat: () => null,
}))

vi.mock('@/components/chat/WelcomeScreen', () => ({
  WelcomeScreen: () => null,
}))

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

function message(
  role: Message['role'],
  turnId: string,
  tokenCount: number,
  timestamp: number,
): Message {
  return {
    role,
    turnId,
    content: 'x'.repeat(tokenCount * 4),
    timestamp: new Date(timestamp),
  }
}

function props(
  chatId: string,
  messages: Message[],
): ComponentProps<typeof ChatMessages> {
  return {
    chatId,
    messages,
    contextWindowTokens: 1000,
    isDarkMode: false,
    models,
    selectedModel: models[0].modelName,
    autoIntelligence: DEFAULT_AUTO_INTELLIGENCE_LEVEL,
    setAutoIntelligence: () => {
      throw new Error('Unexpected intelligence change while rendering messages')
    },
  }
}

describe('ChatMessages archive boundary', () => {
  it('does not hide visible messages as pending input consumes the budget', () => {
    const messages = [
      message('user', 'turn-1-user', 200, 1),
      message('assistant', 'turn-1-assistant', 200, 2),
      message('user', 'turn-2-user', 200, 3),
      message('assistant', 'turn-2-assistant', 200, 4),
    ]
    const { rerender } = render(
      <ChatMessages {...props('chat-1', messages)} pendingContextTokens={0} />,
    )

    expect(screen.getByTestId('message-turn-1-user')).toBeInTheDocument()

    rerender(
      <ChatMessages
        {...props('chat-1', messages)}
        pendingContextTokens={800}
      />,
    )

    expect(screen.getByTestId('message-turn-1-user')).toBeInTheDocument()
    expect(screen.getByTestId('message-turn-2-assistant')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps the active turn visible as its assistant response grows', () => {
    const initialMessages = [
      message('user', 'old-user', 100, 1),
      message('assistant', 'old-assistant', 100, 2),
      message('user', 'active-user', 100, 3),
    ]
    const { rerender } = render(
      <ChatMessages
        {...props('chat-1', initialMessages)}
        isStreamingResponse
      />,
    )

    const streamingMessages = [
      ...initialMessages,
      message('assistant', 'active-assistant', 300, 4),
    ]
    rerender(
      <ChatMessages
        {...props('chat-1', streamingMessages)}
        isStreamingResponse
      />,
    )

    const grownMessages = [
      ...streamingMessages.slice(0, -1),
      message('assistant', 'active-assistant', 850, 4),
    ]
    rerender(
      <ChatMessages {...props('chat-1', grownMessages)} isStreamingResponse />,
    )

    expect(screen.getByTestId('message-active-user')).toBeInTheDocument()
    expect(screen.getByTestId('message-active-assistant')).toBeInTheDocument()
  })

  it('initializes a fresh collapsed prefix when the chat changes', () => {
    const shortChat = [message('user', 'short-message', 100, 1)]
    const longChat = [
      message('user', 'long-1', 300, 1),
      message('assistant', 'long-2', 300, 2),
      message('user', 'long-3', 300, 3),
      message('assistant', 'long-4', 300, 4),
    ]
    const { rerender } = render(
      <ChatMessages {...props('short-chat', shortChat)} />,
    )

    rerender(<ChatMessages {...props('long-chat', longChat)} />)

    expect(screen.queryByTestId('message-long-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-long-4')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Show \d+ earlier messages/ }),
    ).toBeInTheDocument()
  })

  it('initializes the collapsed prefix when an existing chat hydrates', () => {
    const longChat = [
      message('user', 'hydrated-1', 300, 1),
      message('assistant', 'hydrated-2', 300, 2),
      message('user', 'hydrated-3', 300, 3),
      message('assistant', 'hydrated-4', 300, 4),
    ]
    const { rerender } = render(
      <ChatMessages {...props('hydrated-chat', [])} />,
    )

    rerender(<ChatMessages {...props('hydrated-chat', longChat)} />)

    expect(screen.queryByTestId('message-hydrated-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-hydrated-4')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Show \d+ earlier messages/ }),
    ).toBeInTheDocument()
  })

  it('reinitializes the collapsed prefix after the same chat temporarily empties', () => {
    const longChat = [
      message('user', 'rehydrated-1', 300, 1),
      message('assistant', 'rehydrated-2', 300, 2),
      message('user', 'rehydrated-3', 300, 3),
      message('assistant', 'rehydrated-4', 300, 4),
    ]
    const { rerender } = render(
      <ChatMessages {...props('same-chat', longChat)} />,
    )

    rerender(<ChatMessages {...props('same-chat', [])} />)
    rerender(<ChatMessages {...props('same-chat', longChat)} />)

    expect(screen.queryByTestId('message-rehydrated-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-rehydrated-4')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Show \d+ earlier messages/ }),
    ).toBeInTheDocument()
  })

  it('keeps a blank chat first turn live as the response grows', () => {
    const firstUserMessage = message('user', 'blank-user', 100, 1)
    const { rerender } = render(<ChatMessages {...props('blank-chat', [])} />)

    rerender(<ChatMessages {...props('blank-chat', [firstUserMessage])} />)
    rerender(
      <ChatMessages
        {...props('blank-chat', [
          firstUserMessage,
          message('assistant', 'blank-assistant', 1000, 2),
        ])}
        isStreamingResponse
      />,
    )

    expect(screen.getByTestId('message-blank-user')).toBeInTheDocument()
    expect(screen.getByTestId('message-blank-assistant')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument()
  })
})
