import {
  parseChatGPTConversations,
  parseClaudeConversations,
  parseClaudeProjects,
  type ChatGPTConversation,
  type ClaudeConversation,
  type ClaudeProject,
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

    expect(result[0].messages).toHaveLength(2)
  })

  it('uses conversation create_time when message create_time is missing', () => {
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
            },
          },
        },
      },
    ]

    const result = parseChatGPTConversations(data, createParseOptions())

    expect(result[0].messages[0].timestamp).toEqual(
      new Date(conversationTime * 1000),
    )
  })

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

  it('respects isCloudSyncEnabled option', () => {
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
      createParseOptions({ isCloudSyncEnabled: true }),
    )

    expect(result[0].isLocalOnly).toBe(false)
  })

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

describe('parseClaudeProjects', () => {
  it('parses a basic project without documents', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-123',
        name: 'My Project',
        description: 'A test project',
        prompt_template: 'You are a helpful assistant.',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('My Project')
    expect(result[0].description).toBe('A test project')
    expect(result[0].systemInstructions).toBe('You are a helpful assistant.')
    expect(result[0].docs).toHaveLength(0)
  })

  it('parses a project with documents', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-with-docs',
        name: 'Documented Project',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        docs: [
          {
            uuid: 'doc-1',
            filename: 'readme.md',
            content: '# Project README\n\nThis is the readme.',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'doc-2',
            filename: 'guide.md',
            content: '# User Guide\n\nHow to use this project.',
            created_at: '2024-01-15T10:05:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result[0].docs).toHaveLength(2)
    expect(result[0].docs[0].filename).toBe('readme.md')
    expect(result[0].docs[0].content).toBe(
      '# Project README\n\nThis is the readme.',
    )
    expect(result[0].docs[1].filename).toBe('guide.md')
  })

  it('uses default values for missing optional fields', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-minimal',
        name: '',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        docs: [
          {
            uuid: 'doc-1',
            filename: 'notes.md',
            content: 'Some notes',
            created_at: '2024-01-15T10:00:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result[0].name).toBe('Imported Project')
    expect(result[0].description).toBe('')
    expect(result[0].systemInstructions).toBe('')
  })

  it('skips the empty starter project that Claude includes in every export', () => {
    const data: ClaudeProject[] = [
      {
        uuid: '019740f9-c653-7517-a8a7-df268f0c7062',
        name: '',
        description: '',
        prompt_template: '',
        created_at: '2025-06-05T16:43:20.527453+00:00',
        updated_at: '2026-06-23T01:46:07.098892+00:00',
        docs: [
          {
            uuid: '374c5c9c-a29f-4b9a-bc23-372b50851f9d',
            filename: '',
            content: '',
            created_at: '2025-06-05T16:43:20.527453+00:00',
          },
        ],
      },
      {
        uuid: '019ef151-6dd2-76d5-abf7-91e33254dff8',
        name: 'Blog Diagrams',
        description: '',
        prompt_template: 'In this project you will help me make great diagrams',
        created_at: '2026-06-22T21:51:46.133686+00:00',
        updated_at: '2026-06-23T05:19:17.325324+00:00',
        docs: [],
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Blog Diagrams')
    expect(result[0].systemInstructions).toBe(
      'In this project you will help me make great diagrams',
    )
  })

  it('filters out documents with missing content or filename', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-filter-docs',
        name: 'Filter Docs Project',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        docs: [
          {
            uuid: 'doc-valid',
            filename: 'valid.md',
            content: 'Valid content',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'doc-no-content',
            filename: 'no-content.md',
            content: '',
            created_at: '2024-01-15T10:00:00Z',
          },
          {
            uuid: 'doc-no-filename',
            filename: '',
            content: 'Has content but no filename',
            created_at: '2024-01-15T10:00:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result[0].docs).toHaveLength(1)
    expect(result[0].docs[0].filename).toBe('valid.md')
  })

  it('parses multiple projects', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-1',
        name: 'First Project',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
      },
      {
        uuid: 'proj-2',
        name: 'Second Project',
        description: 'The second one',
        prompt_template: 'Be concise.',
        created_at: '2024-01-16T10:00:00Z',
        updated_at: '2024-01-16T10:00:00Z',
        docs: [
          {
            uuid: 'doc-1',
            filename: 'notes.md',
            content: 'Some notes',
            created_at: '2024-01-16T10:00:00Z',
          },
        ],
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('First Project')
    expect(result[1].name).toBe('Second Project')
    expect(result[1].description).toBe('The second one')
    expect(result[1].systemInstructions).toBe('Be concise.')
    expect(result[1].docs).toHaveLength(1)
  })

  it('handles undefined docs array', () => {
    const data: ClaudeProject[] = [
      {
        uuid: 'proj-no-docs',
        name: 'No Docs',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        docs: undefined,
      },
    ]

    const result = parseClaudeProjects(data)

    expect(result[0].docs).toHaveLength(0)
  })
})
