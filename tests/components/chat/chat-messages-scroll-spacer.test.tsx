import { ChatMessages } from '@/components/chat/chat-messages'
import type { Message } from '@/components/chat/types'
import {
  DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  type BaseModel,
} from '@/config/models'
import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/renderers/client', () => ({
  getRendererRegistry: () => ({
    getMessageRenderer: () => ({
      render: ({ message }: { message: Message }) => (
        <div>{message.content}</div>
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

const MESSAGE_TIMESTAMPS = {
  'old-user': 1,
  'old-assistant': 2,
  'active-user': 3,
  'active-assistant': 4,
}

function message(
  role: Message['role'],
  turnId: keyof typeof MESSAGE_TIMESTAMPS,
): Message {
  return {
    role,
    turnId,
    content: `${role} message`,
    timestamp: new Date(MESSAGE_TIMESTAMPS[turnId]),
  }
}

function props(messages: Message[]): ComponentProps<typeof ChatMessages> {
  return {
    chatId: 'chat-1',
    messages,
    isDarkMode: false,
    models,
    selectedModel: models[0].modelName,
    autoIntelligence: DEFAULT_AUTO_INTELLIGENCE_LEVEL,
    setAutoIntelligence: () => {
      throw new Error('Unexpected intelligence change while rendering messages')
    },
  }
}

function conversation(
  messages: Message[],
  options: { isStreamingResponse?: boolean; showScrollButton?: boolean } = {},
) {
  return (
    <div data-scroll-container="main">
      <ChatMessages {...props(messages)} {...options} />
    </div>
  )
}

function setScrollLayout(
  container: HTMLElement,
  spacer: HTMLElement,
  layout: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, value: layout.scrollHeight },
    scrollTop: { configurable: true, value: layout.scrollTop },
    clientHeight: { configurable: true, value: layout.clientHeight },
  })
  Object.defineProperty(spacer, 'offsetHeight', {
    configurable: true,
    value: 500,
  })
}

describe('ChatMessages scroll spacer', () => {
  it('keeps the prompt anchor stable while a long response streams', () => {
    const initialMessages = [
      message('user', 'old-user'),
      message('assistant', 'old-assistant'),
    ]
    const { container, rerender } = render(conversation(initialMessages))

    const messagesWithPrompt = [
      ...initialMessages,
      message('user', 'active-user'),
    ]
    rerender(conversation(messagesWithPrompt))
    expect(container.querySelector('[data-spacer]')).toBeInTheDocument()

    const streamingMessages = [
      ...messagesWithPrompt,
      message('assistant', 'active-assistant'),
    ]
    rerender(
      conversation(streamingMessages, {
        isStreamingResponse: true,
        showScrollButton: true,
      }),
    )
    expect(container.querySelector('[data-spacer]')).toBeInTheDocument()

    rerender(conversation(streamingMessages, { isStreamingResponse: true }))
    expect(container.querySelector('[data-spacer]')).toBeInTheDocument()

    setScrollLayout(
      container.querySelector('[data-scroll-container="main"]')!,
      container.querySelector('[data-spacer]')!,
      { scrollHeight: 2400, scrollTop: 900, clientHeight: 800 },
    )
    rerender(conversation(streamingMessages))
    expect(container.querySelector('[data-spacer]')).not.toBeInTheDocument()
  })

  it('does not treat an existing scroll button as response overflow', () => {
    const initialMessages = [
      message('user', 'old-user'),
      message('assistant', 'old-assistant'),
    ]
    const { container, rerender } = render(
      conversation(initialMessages, { showScrollButton: true }),
    )

    const messagesWithPrompt = [
      ...initialMessages,
      message('user', 'active-user'),
    ]
    rerender(conversation(messagesWithPrompt, { showScrollButton: true }))

    const streamingMessages = [
      ...messagesWithPrompt,
      message('assistant', 'active-assistant'),
    ]
    rerender(
      conversation(streamingMessages, {
        isStreamingResponse: true,
        showScrollButton: true,
      }),
    )
    setScrollLayout(
      container.querySelector('[data-scroll-container="main"]')!,
      container.querySelector('[data-spacer]')!,
      { scrollHeight: 1400, scrollTop: 500, clientHeight: 800 },
    )
    rerender(conversation(streamingMessages, { showScrollButton: true }))

    expect(container.querySelector('[data-spacer]')).toBeInTheDocument()
  })
})
