import type { Message } from '@/components/chat/types'
import {
  CONTEXT_WINDOW_USAGE_RATIO,
  estimateMessageTokens,
  estimateTokenCount,
  findContextStartIndex,
  getContextTokenBudget,
  parseContextWindowTokens,
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

describe('parseContextWindowTokens', () => {
  it('parses "64k tokens" style values', () => {
    expect(parseContextWindowTokens('64k tokens')).toBe(64000)
    expect(parseContextWindowTokens('256K tokens')).toBe(256000)
    expect(parseContextWindowTokens('32000')).toBe(32000)
  })

  it('falls back to a default for missing or malformed values', () => {
    expect(parseContextWindowTokens(undefined)).toBe(64000)
    expect(parseContextWindowTokens('unknown')).toBe(64000)
  })
})

describe('getContextTokenBudget', () => {
  it('reserves headroom below the full context window', () => {
    expect(getContextTokenBudget('100k tokens')).toBe(
      Math.floor(100000 * CONTEXT_WINDOW_USAGE_RATIO),
    )
  })
})

describe('estimateMessageTokens', () => {
  it('includes quote and attachment text but not thoughts', () => {
    const msg: Message = {
      role: 'user',
      content: 'a'.repeat(40),
      thoughts: 'b'.repeat(40),
      quote: 'c'.repeat(40),
      attachments: [
        {
          id: '1',
          type: 'document',
          fileName: 'doc.txt',
          textContent: 'd'.repeat(40),
        },
      ],
      timestamp: new Date(),
    }
    expect(estimateMessageTokens(msg)).toBe(30)
  })

  it('counts assistant tool calls and search reasoning', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'a'.repeat(40),
      searchReasoning: 'b'.repeat(40),
      toolCalls: [
        {
          id: 'call_1',
          name: 'cccc',
          arguments: 'd'.repeat(40),
        },
      ],
      timestamp: new Date(),
    }
    expect(estimateMessageTokens(msg)).toBe(31)
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
})

describe('selectMessagesWithinBudget', () => {
  it('selects the most recent messages that fit the model budget', () => {
    // 1k-token context window → 900-token budget; each message is 400 tokens
    const messages = [
      makeMessage('user', 1600),
      makeMessage('assistant', 1600),
      makeMessage('user', 1600),
    ]
    const selected = selectMessagesWithinBudget(messages, '1k tokens')
    expect(selected).toHaveLength(2)
    expect(selected[0]).toBe(messages[1])
    expect(selected[1]).toBe(messages[2])
  })
})
