import type { Message } from '@/components/chat/types'
import { REASONING_HISTORY_POLICIES } from '@/utils/reasoning-history'
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateMessageTokens,
  estimateTokenCount,
  findContextStartIndex,
  getContextTokenBudget,
  getHistoryTokenBudget,
  getSmallestContextWindowTokens,
  resolveContextWindowTokens,
  selectMessagesWithinBudget,
} from '@/utils/token-estimation'
import { describe, expect, it } from 'vitest'

function makeMessage(
  role: 'user' | 'assistant',
  contentLength: number,
): Message {
  return {
    role,
    content: 'a'.repeat(contentLength),
    timestamp: new Date(),
  }
}

describe('estimateTokenCount', () => {
  it('estimates roughly 4 characters per token', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100)
    expect(estimateTokenCount('abc')).toBe(1)
    expect(estimateTokenCount('')).toBe(0)
    expect(estimateTokenCount(undefined)).toBe(0)
  })
})

describe('resolveContextWindowTokens', () => {
  it('uses the chat config budget', () => {
    expect(
      resolveContextWindowTokens({
        chatConfig: { contextWindowTokens: 256000 },
      }),
    ).toBe(256000)
  })

  it('falls back to the default when the model reports no window', () => {
    expect(resolveContextWindowTokens({})).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(resolveContextWindowTokens(undefined)).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    )
  })

  it('finds the smallest context window across candidates', () => {
    expect(
      getSmallestContextWindowTokens([
        { chatConfig: { contextWindowTokens: 256000 } },
        { chatConfig: { contextWindowTokens: 32000 } },
        {},
      ]),
    ).toBe(32000)
    expect(getSmallestContextWindowTokens([])).toBeUndefined()
  })
})

describe('getContextTokenBudget', () => {
  it('reserves headroom below the full context window', () => {
    expect(getContextTokenBudget(100001)).toBe(80000)
  })

  it('reserves pending input tokens before budgeting persisted history', () => {
    expect(getHistoryTokenBudget(1000, 250)).toBe(550)
    expect(getHistoryTokenBudget(1000, 1000)).toBe(0)
  })
})

describe('estimateMessageTokens', () => {
  it('includes quote and attachment text but excludes user thoughts', () => {
    const msg: Message = {
      role: 'user',
      content: 'a'.repeat(40),
      thoughts: 'b'.repeat(80),
      quote: 'c'.repeat(120),
      documentContent: 'f'.repeat(24),
      attachments: [
        {
          id: '1',
          type: 'document',
          fileName: 'doc.txt',
          textContent: 'd'.repeat(160),
          description: 'e'.repeat(20),
        },
      ],
      timestamp: new Date(),
    }
    expect(estimateMessageTokens(msg)).toBe(91)
    expect(
      estimateMessageTokens(msg, {
        reasoningHistoryPolicy: REASONING_HISTORY_POLICIES.all,
      }),
    ).toBe(91)
    expect(estimateMessageTokens({ ...msg, quote: undefined })).toBe(61)
    expect(estimateMessageTokens({ ...msg, attachments: [] })).toBe(46)
  })

  it('counts assistant tool calls and search reasoning', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'a'.repeat(40),
      searchReasoning: 'b'.repeat(80),
      toolCalls: [
        {
          id: 'call_1',
          name: 'cccc',
          arguments: 'd'.repeat(120),
        },
      ],
      timestamp: new Date(),
    }
    expect(estimateMessageTokens(msg)).toBe(61)
    expect(estimateMessageTokens({ ...msg, searchReasoning: undefined })).toBe(
      41,
    )
    expect(estimateMessageTokens({ ...msg, toolCalls: [] })).toBe(30)
  })
})

describe('findContextStartIndex', () => {
  it('returns 0 when all messages fit', () => {
    const messages = [
      makeMessage('user', 40),
      makeMessage('assistant', 40),
      makeMessage('user', 40),
    ]
    expect(findContextStartIndex(messages, 1000)).toBe(0)
  })

  it('archives the oldest messages once the budget is exceeded', () => {
    // Each message is ~100 tokens; budget fits only the last two
    const messages = [
      makeMessage('user', 400),
      makeMessage('assistant', 400),
      makeMessage('user', 400),
      makeMessage('assistant', 400),
    ]
    expect(findContextStartIndex(messages, 250)).toBe(2)
  })

  it('always keeps the most recent message even when over budget', () => {
    const messages = [makeMessage('user', 400), makeMessage('user', 4000)]
    expect(findContextStartIndex(messages, 10)).toBe(1)
  })

  it('can archive every persisted message when a pending draft is newest', () => {
    const messages = [makeMessage('user', 400)]

    expect(findContextStartIndex(messages, 0, { keepMostRecent: false })).toBe(
      1,
    )
  })

  it('archives more history when preserved reasoning consumes the budget', () => {
    const assistant = makeMessage('assistant', 40)
    assistant.thoughts = 'b'.repeat(800)
    const messages = [assistant, makeMessage('user', 40)]

    expect(findContextStartIndex(messages, 100)).toBe(0)
    expect(
      findContextStartIndex(messages, 100, {
        reasoningHistoryPolicy: REASONING_HISTORY_POLICIES.all,
      }),
    ).toBe(1)
  })

  it('counts tool-call reasoning only for tool-call policy models', () => {
    const ordinary = makeMessage('assistant', 40)
    ordinary.thoughts = 'b'.repeat(40)
    const toolCall = makeMessage('assistant', 40)
    toolCall.thoughts = 'b'.repeat(40)
    toolCall.toolCalls = [{ id: 'call_1', name: 'tool', arguments: '{}' }]
    const options = {
      reasoningHistoryPolicy: REASONING_HISTORY_POLICIES.toolCallOnly,
    } as const

    expect(estimateMessageTokens(ordinary, options)).toBe(10)
    expect(estimateMessageTokens(toolCall, options)).toBe(22)
  })
})

describe('selectMessagesWithinBudget', () => {
  it('selects the most recent messages that fit the model budget', () => {
    // 1k-token context window → 800-token budget; each message is 400 tokens
    const messages = [
      makeMessage('user', 1600),
      makeMessage('assistant', 1600),
      makeMessage('user', 1600),
    ]
    const selected = selectMessagesWithinBudget(messages, 1000)
    expect(selected).toHaveLength(2)
    expect(selected[0]).toBe(messages[1])
    expect(selected[1]).toBe(messages[2])
  })
})
