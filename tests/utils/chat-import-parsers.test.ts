import {
  parseChatGPTConversations,
  parseClaudeConversations,
  type ChatGPTConversation,
  type ClaudeConversation,
  type ParseOptions,
} from '@/utils/chat-import-parsers'
import { describe, expect, it } from 'vitest'

const createParseOptions = (
  overrides?: Partial<ParseOptions>,
): ParseOptions => {
  let counter = 0
  return {
    generateChatId:
      overrides?.generateChatId ?? (() => `test_chat_${++counter}`),
    isCloudSyncEnabled: overrides?.isCloudSyncEnabled ?? false,
  }
}

describe('parseChatGPTConversations', () => {
  it('parses a basic conversation with user and assistant messages', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Test Conversation',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            children: ['msg2'],
            message: {
              author: { role: 'user' },
              content: {
                content_type: 'text',
                parts: ['Hello, how are you?'],
              },
              create_time: 1700000100,
            },
          },
          msg2: {
            id: 'msg2',
            parent: 'msg1',
            message: {
              author: { role: 'assistant' },
              content: {
                content_type: 'text',
                parts: ["I'm doing well, thank you!"],
              },
              create_time: 1700000200,
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Test Conversation')
    expect(result[0].messages).toHaveLength(2)
    expect(result[0].messages[0].role).toBe('user')
    expect(result[0].messages[0].content).toBe('Hello, how are you?')
    expect(result[0].messages[1].role).toBe('assistant')
    expect(result[0].messages[1].content).toBe("I'm doing well, thank you!")
    expect(result[0].isLocalOnly).toBe(true)
  })

  it('respects isCloudSyncEnabled option', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Synced Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Test'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(
      data,
      createParseOptions({ isCloudSyncEnabled: true }),
    )

    expect(result[0].isLocalOnly).toBe(false)
  })

  it('handles multimodal_text content type and filters non-string parts', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Multimodal Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              content: {
                content_type: 'multimodal_text',
                parts: [
                  'Here is an image:',
                  { type: 'image', url: 'http://example.com/image.png' },
                  'What do you see?',
                ],
              },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].messages[0].content).toBe(
      'Here is an image:\nWhat do you see?',
    )
  })

  it('extracts thoughts from parent chain for assistant messages', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Chat with Thoughts',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            children: ['thoughts1'],
            message: {
              author: { role: 'user' },
              content: {
                content_type: 'text',
                parts: ['Explain quantum computing'],
              },
            },
          },
          thoughts1: {
            id: 'thoughts1',
            parent: 'msg1',
            children: ['response1'],
            message: {
              author: { role: 'assistant' },
              content: {
                content_type: 'thoughts',
                thoughts: [
                  { content: 'Let me think about quantum computing...' },
                  { summary: 'Considering key concepts' },
                ],
              },
            },
          },
          response1: {
            id: 'response1',
            parent: 'thoughts1',
            message: {
              author: { role: 'assistant' },
              content: {
                content_type: 'text',
                parts: ['Quantum computing uses qubits...'],
              },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].messages).toHaveLength(2)
    const assistantMsg = result[0].messages[1]
    expect(assistantMsg.thoughts).toBe(
      'Let me think about quantum computing...\n\nConsidering key concepts',
    )
  })

  it('extracts thinking duration from reasoning_recap metadata', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Chat with Duration',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            children: ['recap1'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Complex question'] },
            },
          },
          recap1: {
            id: 'recap1',
            parent: 'msg1',
            children: ['response1'],
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'reasoning_recap' },
              metadata: { finished_duration_sec: 45 },
            },
          },
          response1: {
            id: 'response1',
            parent: 'recap1',
            message: {
              author: { role: 'assistant' },
              content: {
                content_type: 'text',
                parts: ['After careful consideration...'],
              },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    const assistantMsg = result[0].messages[1]
    expect(assistantMsg.thinkingDuration).toBe(45)
  })

  it('skips conversations with no valid messages', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Empty Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['system'],
          },
          system: {
            id: 'system',
            parent: 'root',
            message: {
              author: { role: 'system' },
              content: { content_type: 'text', parts: ['System message'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result).toHaveLength(0)
  })

  it('uses default title when title is missing', () => {
    const data: ChatGPTConversation[] = [
      {
        title: '',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: {
            id: 'root',
            children: ['msg1'],
          },
          msg1: {
            id: 'msg1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Hello'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].title).toBe('Imported Chat')
  })

  it('handles client-created-root as a root node', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Client Root Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          msg1: {
            id: 'msg1',
            parent: 'client-created-root',
            children: ['msg2'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Starting message'] },
            },
          },
          msg2: {
            id: 'msg2',
            parent: 'msg1',
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Response'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].messages).toEqual([
      {
        role: 'user',
        content: 'Starting message',
        timestamp: new Date('2023-11-14T22:13:20.000Z'),
      },
      {
        role: 'assistant',
        content: 'Response',
        timestamp: new Date('2023-11-14T22:13:20.000Z'),
      },
    ])
  })

  it.each([
    [undefined, '2023-11-14T22:13:20.000Z'],
    [1700000100, '2023-11-14T22:15:00.000Z'],
  ] as const)(
    'uses message time or conversation fallback: %s',
    (messageTime, expected) => {
      const conversationTime = 1700000000
      const data: ChatGPTConversation[] = [
        {
          title: 'No Message Time',
          create_time: conversationTime,
          update_time: 1700001000,
          mapping: {
            root: {
              id: 'root',
              children: ['msg1'],
            },
            msg1: {
              id: 'msg1',
              parent: 'root',
              message: {
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['Hello'] },
                create_time: messageTime,
              },
            },
          },
        },
      ]

      const result = parseChatGPTConversations(data, createParseOptions())

      expect(result[0].messages[0].timestamp).toEqual(new Date(expected))
    },
  )

  it('parses multiple conversations', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'First Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: { id: 'root', children: ['msg1'] },
          msg1: {
            id: 'msg1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['First'] },
            },
          },
        },
      },
      {
        title: 'Second Chat',
        create_time: 1700002000,
        update_time: 1700003000,
        mapping: {
          root: { id: 'root', children: ['msg1'] },
          msg1: {
            id: 'msg1',
            parent: 'root',
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Second'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('First Chat')
    expect(result[1].title).toBe('Second Chat')
  })

  it('ignores empty or whitespace-only content', () => {
    const data: ChatGPTConversation[] = [
      {
        title: 'Whitespace Chat',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: { id: 'root', children: ['msg1', 'msg2'] },
          msg1: {
            id: 'msg1',
            parent: 'root',
            children: ['msg2'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['   '] },
            },
          },
          msg2: {
            id: 'msg2',
            parent: 'msg1',
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Valid response'] },
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].messages).toHaveLength(1)
    expect(result[0].messages[0].content).toBe('Valid response')
  })
})

describe('parseClaudeConversations', () => {
  it('parses a basic conversation with human and assistant messages', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-123',
        name: 'Test Claude Chat',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: 'What is the capital of France?',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'msg-2',
            text: 'The capital of France is Paris.',
            sender: 'assistant',
            created_at: '2024-01-15T10:00:30Z',
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Test Claude Chat')
    expect(result[0].messages).toHaveLength(2)
    expect(result[0].messages[0].role).toBe('user')
    expect(result[0].messages[0].content).toBe('What is the capital of France?')
    expect(result[0].messages[1].role).toBe('assistant')
    expect(result[0].messages[1].content).toBe(
      'The capital of France is Paris.',
    )
  })

  it('extracts thinking content from assistant messages', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-thinking',
        name: 'Thinking Chat',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: 'Solve this complex problem',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'msg-2',
            text: 'Here is the solution...',
            sender: 'assistant',
            created_at: '2024-01-15T10:01:00Z',
            content: [
              {
                type: 'thinking',
                thinking: 'First, I need to analyze the problem...',
                start_timestamp: '2024-01-15T10:00:05Z',
                stop_timestamp: '2024-01-15T10:00:15Z',
              },
              {
                type: 'thinking',
                thinking: 'Now let me consider the edge cases...',
                start_timestamp: '2024-01-15T10:00:15Z',
                stop_timestamp: '2024-01-15T10:00:30Z',
              },
              {
                type: 'text',
              },
            ],
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    const assistantMsg = result[0].messages[1]
    expect(assistantMsg.thoughts).toBe(
      'First, I need to analyze the problem...\n\nNow let me consider the edge cases...',
    )
    expect(assistantMsg.thinkingDuration).toBe(25) // 30 seconds total
  })

  it('calculates thinking duration correctly from timestamps', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-duration',
        name: 'Duration Test',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: 'Question',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'msg-2',
            text: 'Answer',
            sender: 'assistant',
            created_at: '2024-01-15T10:02:00Z',
            content: [
              {
                type: 'thinking',
                thinking: 'Thinking...',
                start_timestamp: '2024-01-15T10:00:00Z',
                stop_timestamp: '2024-01-15T10:01:00Z',
              },
            ],
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result[0].messages[1].thinkingDuration).toBe(60)
  })

  it('handles conversations with empty chat_messages', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-empty',
        name: 'Empty Chat',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        chat_messages: [],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result).toHaveLength(0)
  })

  it('skips messages with empty text', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-skip',
        name: 'Skip Empty',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: '',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'msg-2',
            text: '   ',
            sender: 'human',
            created_at: '2024-01-15T10:00:05Z',
          },
          {
            uuid: 'msg-3',
            text: 'Valid message',
            sender: 'human',
            created_at: '2024-01-15T10:00:10Z',
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result[0].messages).toHaveLength(1)
    expect(result[0].messages[0].content).toBe('Valid message')
  })

  it('uses default title when name is missing', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-no-name',
        name: '',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: 'Hello',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result[0].title).toBe('Imported Chat')
  })

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    'respects Claude cloud sync preference %s',
    (enabled, localOnly) => {
      const data: ClaudeConversation[] = [
        {
          uuid: 'conv-sync',
          name: 'Synced',
          created_at: '2024-01-15T10:00:00Z',
          updated_at: '2024-01-15T10:00:00Z',
          chat_messages: [
            {
              uuid: 'msg-1',
              text: 'Test',
              sender: 'human',
              created_at: '2024-01-15T10:00:00Z',
            },
          ],
        },
      ]

      const result = parseClaudeConversations(
        data,
        createParseOptions({ isCloudSyncEnabled: enabled }),
      )

      expect(result[0].isLocalOnly).toBe(localOnly)
    },
  )

  it('parses multiple conversations', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-1',
        name: 'First',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        chat_messages: [
          {
            uuid: 'm1',
            text: 'Hi',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
          },
        ],
      },
      {
        uuid: 'conv-2',
        name: 'Second',
        created_at: '2024-01-16T10:00:00Z',
        updated_at: '2024-01-16T10:00:00Z',
        chat_messages: [
          {
            uuid: 'm2',
            text: 'Hello',
            sender: 'human',
            created_at: '2024-01-16T10:00:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('First')
    expect(result[1].title).toBe('Second')
  })

  it('does not add thinking data to human messages', () => {
    const data: ClaudeConversation[] = [
      {
        uuid: 'conv-human-content',
        name: 'Human Content',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            text: 'User message',
            sender: 'human',
            created_at: '2024-01-15T10:00:00Z',
            content: [
              {
                type: 'thinking',
                thinking: 'This should be ignored',
              },
            ],
          },
        ],
      },
    ]

    const result = parseClaudeConversations(data, createParseOptions())

    expect(result[0].messages[0].thoughts).toBeUndefined()
  })
})
