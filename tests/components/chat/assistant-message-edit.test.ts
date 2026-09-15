import { replaceAssistantContent } from '@/components/chat/assistant-message-edit'
import type { Message } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

const timestamp = new Date('2026-01-01T00:00:00Z')

describe('replaceAssistantContent', () => {
  it('rewrites content and the single content block', () => {
    const message: Message = {
      role: 'assistant',
      content: 'old',
      timestamp,
      timeline: [{ type: 'content', id: 'content-0', content: 'old' }],
    }

    const edited = replaceAssistantContent(message, 'new text')

    expect(edited.content).toBe('new text')
    expect(edited.timeline).toEqual([
      { type: 'content', id: 'content-0', content: 'new text' },
    ])
  })

  it('keeps thinking and tool blocks and collapses split content blocks', () => {
    const message: Message = {
      role: 'assistant',
      content: 'part one part two',
      timestamp,
      timeline: [
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
        { type: 'content', id: 'content-1', content: 'part one ' },
        {
          type: 'web_search',
          id: 'web-search-2',
          state: { query: 'q', status: 'completed', sources: [] },
        },
        { type: 'content', id: 'content-3', content: 'part two' },
      ],
    }

    const edited = replaceAssistantContent(message, 'merged')

    expect(edited.content).toBe('merged')
    expect(edited.timeline?.map((block) => block.type)).toEqual([
      'thinking',
      'content',
      'web_search',
    ])
    expect(edited.timeline?.[1]).toEqual({
      type: 'content',
      id: 'content-1',
      content: 'merged',
    })
  })

  it('synthesizes a timeline for legacy messages without one', () => {
    const message: Message = {
      role: 'assistant',
      content: 'legacy',
      timestamp,
    }

    const edited = replaceAssistantContent(message, 'edited')

    expect(edited.content).toBe('edited')
    expect(edited.timeline).toEqual([
      { type: 'content', id: 'legacy-content', content: 'edited' },
    ])
  })

  it('adds a content block to a message that had none', () => {
    const message: Message = {
      role: 'assistant',
      content: '',
      timestamp,
      timeline: [
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
      ],
    }

    const edited = replaceAssistantContent(message, 'edited')

    expect(edited.timeline?.map((block) => block.id)).toEqual([
      'thinking-0',
      'edited-content',
    ])
    expect(edited.timeline?.[1]).toEqual({
      type: 'content',
      id: 'edited-content',
      content: 'edited',
    })
  })

  it('keeps legacy thoughts when editing a message without a timeline', () => {
    const message: Message = {
      role: 'assistant',
      content: 'legacy',
      thoughts: 'reasoning',
      thinkingDuration: 2,
      timestamp,
    }

    const edited = replaceAssistantContent(message, 'edited')

    expect(edited.timeline).toEqual([
      {
        type: 'thinking',
        id: 'legacy-thinking',
        content: 'reasoning',
        isThinking: false,
        duration: 2,
      },
      { type: 'content', id: 'legacy-content', content: 'edited' },
    ])
  })

  it('does not mutate the original message', () => {
    const message: Message = {
      role: 'assistant',
      content: 'old',
      timestamp,
      timeline: [{ type: 'content', id: 'content-0', content: 'old' }],
    }

    replaceAssistantContent(message, 'new')

    expect(message.content).toBe('old')
    expect(message.timeline?.[0]).toEqual({
      type: 'content',
      id: 'content-0',
      content: 'old',
    })
  })
})
