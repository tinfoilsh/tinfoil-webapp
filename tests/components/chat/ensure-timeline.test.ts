import { ensureTimeline } from '@/components/chat/ensure-timeline'
import { MessageAssembler } from '@/components/chat/hooks/streaming/message-assembler'
import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
import type {
  Message,
  TimelineContentBlock,
  TimelineThinkingBlock,
} from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

/** Minimal assistant message with only the required fields. */
function assistantMsg(overrides: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2025-01-01'),
    ...overrides,
  }
}

describe('ensureTimeline', () => {
  describe('passthrough cases', () => {
    it('returns user messages unchanged', () => {
      const msg: Message = {
        role: 'user',
        content: 'hello',
        timestamp: new Date(),
      }
      expect(ensureTimeline(msg)).toBe(msg)
    })

    it('returns empty assistant messages unchanged (no blocks to create)', () => {
      const msg = assistantMsg()
      expect(ensureTimeline(msg)).toBe(msg)
    })
  })

  describe('content-only messages', () => {
    it('synthesizes a single content block', () => {
      const msg = assistantMsg({ content: 'the answer' })
      const result = ensureTimeline(msg)

      expect(result.timeline).toHaveLength(1)
      const block = result.timeline![0] as TimelineContentBlock
      expect(block.type).toBe('content')
      expect(block.content).toBe('the answer')
      expect(result.content).toBe('the answer')
      expect(result.role).toBe('assistant')
      expect(result.timestamp).toBe(msg.timestamp)
      expect(msg.timeline).toBeUndefined()
    })
  })

  describe('thinking messages', () => {
    it('synthesizes a thinking block from thoughts', () => {
      const msg = assistantMsg({
        content: 'answer',
        thoughts: 'let me think',
        thinkingDuration: 2.5,
      })
      const result = ensureTimeline(msg)

      expect(result.timeline).toHaveLength(2)
      const thinking = result.timeline![0] as TimelineThinkingBlock
      expect(thinking.type).toBe('thinking')
      expect(thinking.content).toBe('let me think')
      expect(thinking.isThinking).toBe(false)
      expect(thinking.duration).toBe(2.5)

      const content = result.timeline![1] as TimelineContentBlock
      expect(content.type).toBe('content')
      expect(content.content).toBe('answer')
    })

    it.each(['', 'still going'])(
      'handles active thinking (isThinking=true, thoughts=%j)',
      (thoughts) => {
        const msg = assistantMsg({
          thoughts,
          isThinking: true,
        })
        const result = ensureTimeline(msg)

        expect(result.timeline).toEqual([
          {
            type: 'thinking',
            id: 'legacy-thinking',
            content: thoughts,
            isThinking: true,
            duration: undefined,
          },
        ])
      },
    )

    it('ignores whitespace-only thoughts', () => {
      const msg = assistantMsg({ content: 'answer', thoughts: '   ' })
      const result = ensureTimeline(msg)

      expect(result.timeline).toHaveLength(1)
      expect(result.timeline![0].type).toBe('content')
    })
  })

  describe('web search messages', () => {
    it('handles web search without thinking', () => {
      const msg = assistantMsg({
        content: 'answer',
        webSearch: { query: 'q', status: 'completed' },
      })
      const result = ensureTimeline(msg)

      const types = result.timeline!.map((b) => b.type)
      expect(types).toEqual(['web_search', 'content'])
    })
  })

  describe('url fetches', () => {
    it('places url fetches at the start', () => {
      const msg = assistantMsg({
        content: 'answer',
        urlFetches: [
          { id: 'f1', url: 'https://a.com', status: 'completed' },
          { id: 'f2', url: 'https://b.com', status: 'fetching' },
        ],
      })
      const result = ensureTimeline(msg)

      expect(result.timeline).toEqual([
        {
          type: 'url_fetches',
          id: 'legacy-url-fetches',
          fetches: [
            { id: 'f1', url: 'https://a.com', status: 'completed' },
            { id: 'f2', url: 'https://b.com', status: 'fetching' },
          ],
        },
        { type: 'content', id: 'legacy-content', content: 'answer' },
      ])
    })
  })

  describe('full legacy message (all fields)', () => {
    it('urlFetches → webSearch(pre) → thinking → content', () => {
      const msg = assistantMsg({
        content: 'the answer',
        thoughts: 'reasoning',
        thinkingDuration: 1.0,
        webSearch: {
          query: 'search query',
          status: 'completed',
          sources: [{ title: 'Source', url: 'https://src.com' }],
        },
        webSearchBeforeThinking: true,
        urlFetches: [
          { id: 'f1', url: 'https://page.com', status: 'completed' },
        ],
      })
      const result = ensureTimeline(msg)

      expect(result.timeline).toEqual([
        {
          type: 'url_fetches',
          id: 'legacy-url-fetches',
          fetches: [{ id: 'f1', url: 'https://page.com', status: 'completed' }],
        },
        {
          type: 'web_search',
          id: 'legacy-web-search-pre',
          state: {
            query: 'search query',
            status: 'completed',
            sources: [{ title: 'Source', url: 'https://src.com' }],
          },
        },
        {
          type: 'thinking',
          id: 'legacy-thinking',
          content: 'reasoning',
          isThinking: false,
          duration: 1,
        },
        { type: 'content', id: 'legacy-content', content: 'the answer' },
      ])
    })

    it.each([undefined, false])(
      'urlFetches → thinking → webSearch(post) → content (before=%s)',
      (webSearchBeforeThinking) => {
        const msg = assistantMsg({
          content: 'the answer',
          thoughts: 'reasoning',
          webSearch: { query: 'q', status: 'completed' },
          webSearchBeforeThinking,
          urlFetches: [
            { id: 'f1', url: 'https://page.com', status: 'completed' },
          ],
        })
        const result = ensureTimeline(msg)

        const types = result.timeline!.map((b) => b.type)
        expect(types).toEqual([
          'url_fetches',
          'thinking',
          'web_search',
          'content',
        ])
      },
    )
  })

  describe('roundtrip: toMessage() output survives ensureTimeline', () => {
    it('is a no-op on messages produced by the streaming pipeline', () => {
      const builder = new TimelineBuilder()
      const assembler = new MessageAssembler()

      builder.startThinking()
      builder.appendThinking('let me think about this')
      builder.endThinking(1.5)
      builder.appendContent('here is the answer')

      const message = assembler.toMessage(builder.snapshot())
      expect(message.timeline).toEqual([
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'let me think about this',
          isThinking: false,
          duration: 1.5,
        },
        { type: 'content', id: 'content-1', content: 'here is the answer' },
      ])
      const result = ensureTimeline(message)

      // Should return the exact same object (already has timeline)
      expect(result).toBe(message)
    })

    it('flat fields from toMessage match what ensureTimeline would reconstruct', () => {
      // Build a message via the streaming pipeline
      const builder = new TimelineBuilder()
      const assembler = new MessageAssembler()

      builder.startThinking()
      builder.appendThinking('reasoning')
      builder.endThinking(2.0)
      builder.pushWebSearch({ query: 'test q', status: 'searching' })
      builder.updateWebSearch({
        query: 'test q',
        status: 'completed',
        sources: [{ title: 'Result', url: 'https://r.com' }],
      })
      builder.appendContent('the answer')

      const streamedMsg = assembler.toMessage(builder.snapshot())

      // Now strip the timeline and let ensureTimeline reconstruct it
      const legacy = { ...streamedMsg, timeline: undefined }
      const reconstructed = ensureTimeline(legacy)

      // The flat fields should match
      expect(reconstructed.content).toBe('the answer')
      expect(reconstructed.thoughts).toBe('reasoning')
      expect(reconstructed.webSearch).toEqual({
        query: 'test q',
        status: 'completed',
        sources: [{ title: 'Result', url: 'https://r.com' }],
      })
      expect(reconstructed.thinkingDuration).toBe(2)

      // The reconstructed timeline should have the same block types
      const streamedTypes = streamedMsg.timeline!.map((b) => b.type)
      expect(streamedTypes).toEqual(['thinking', 'web_search', 'content'])
      expect(reconstructed.timeline).toEqual([
        {
          type: 'thinking',
          id: 'legacy-thinking',
          content: 'reasoning',
          isThinking: false,
          duration: 2,
        },
        {
          type: 'web_search',
          id: 'legacy-web-search-post',
          state: {
            query: 'test q',
            status: 'completed',
            sources: [{ title: 'Result', url: 'https://r.com' }],
          },
        },
        { type: 'content', id: 'legacy-content', content: 'the answer' },
      ])
    })

    it('handles url fetches roundtrip', () => {
      const builder = new TimelineBuilder()
      const assembler = new MessageAssembler()

      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })
      builder.updateURLFetch('f1', 'completed')
      builder.startThinking()
      builder.appendThinking('analyzing the page')
      builder.endThinking(1.0)
      builder.appendContent('here is what I found')

      const streamedMsg = assembler.toMessage(builder.snapshot())
      const legacy = { ...streamedMsg, timeline: undefined }
      const reconstructed = ensureTimeline(legacy)

      expect(reconstructed.timeline).toEqual([
        {
          type: 'url_fetches',
          id: 'legacy-url-fetches',
          fetches: [{ id: 'f1', url: 'https://a.com', status: 'completed' }],
        },
        {
          type: 'thinking',
          id: 'legacy-thinking',
          content: 'analyzing the page',
          isThinking: false,
          duration: 1,
        },
        {
          type: 'content',
          id: 'legacy-content',
          content: 'here is what I found',
        },
      ])
      expect(reconstructed.urlFetches).toEqual([
        { id: 'f1', url: 'https://a.com', status: 'completed' },
      ])
    })
  })
})
