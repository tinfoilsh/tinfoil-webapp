import { MessageAssembler } from '@/components/chat/hooks/streaming/message-assembler'
import type { TimelineBlock } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

describe('MessageAssembler', () => {
  describe('derives flat fields from timeline', () => {
    it('derives content from content blocks', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        { type: 'content', id: 'c-0', content: 'hello' },
        { type: 'content', id: 'c-1', content: ' world' },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.content).toBe('hello world')
      expect(msg.role).toBe('assistant')
    })

    it('stores the model display name on the message', () => {
      const asm = new MessageAssembler('Kimi K2.6')

      expect(asm.toMessage([]).modelDisplayName).toBe('Kimi K2.6')
    })

    it('derives thoughts from thinking blocks', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'let me think',
          isThinking: false,
          duration: 2.5,
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.thoughts).toBe('let me think')
      expect(msg.isThinking).toBe(false)
      expect(msg.thinkingDuration).toBe(2.5)
    })

    it('shows isThinking=true for active thinking block', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'thinking...',
          isThinking: true,
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.isThinking).toBe(true)
    })

    it('derives webSearch from web_search blocks', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'web_search',
          id: 'ws-0',
          state: { query: 'test', status: 'searching' },
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.webSearch?.query).toBe('test')
      expect(msg.webSearch?.status).toBe('searching')
    })

    it('uses last web_search block for webSearch state', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'web_search',
          id: 'ws-0',
          state: { query: 'first', status: 'completed' },
        },
        {
          type: 'web_search',
          id: 'ws-1',
          state: {
            query: 'second',
            status: 'completed',
            sources: [{ url: 'https://a.com', title: 'A' }],
          },
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.webSearch?.query).toBe('second')
    })

    it('derives urlFetches from url_fetches blocks', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'url_fetches',
          id: 'uf-0',
          fetches: [
            { id: 'f1', url: 'https://a.com', status: 'completed' },
            { id: 'f2', url: 'https://b.com', status: 'fetching' },
          ],
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.urlFetches).toHaveLength(2)
      expect(msg.urlFetches![0].status).toBe('completed')
    })

    it('derives webSearchBeforeThinking from block order', () => {
      const asm = new MessageAssembler()

      // Search before thinking
      const timeline1: TimelineBlock[] = [
        {
          type: 'web_search',
          id: 'ws-0',
          state: { query: 'q', status: 'completed' },
        },
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
      ]
      expect(asm.toMessage(timeline1).webSearchBeforeThinking).toBe(true)

      // Thinking before search
      const timeline2: TimelineBlock[] = [
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
        {
          type: 'web_search',
          id: 'ws-0',
          state: { query: 'q', status: 'completed' },
        },
      ]
      expect(asm.toMessage(timeline2).webSearchBeforeThinking).toBeUndefined()
    })

    it('omits undefined optional fields for empty timeline', () => {
      const asm = new MessageAssembler()
      const msg = asm.toMessage([])
      expect(msg.thoughts).toBeUndefined()
      expect(msg.webSearch).toBeUndefined()
      expect(msg.urlFetches).toBeUndefined()
      expect(msg.annotations).toBeUndefined()
      expect(msg.searchReasoning).toBeUndefined()
    })

    it('passes timeline through', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        { type: 'content', id: 'c-0', content: 'test' },
      ]
      const msg = asm.toMessage(timeline)
      expect(msg.timeline).toEqual(timeline)
    })
  })

  describe('annotations', () => {
    it('collects annotations via addAnnotation', () => {
      const asm = new MessageAssembler()
      asm.addAnnotation('https://a.com', 'A')
      asm.addAnnotation('https://b.com', 'B')

      const msg = asm.toMessage([])
      expect(msg.annotations).toHaveLength(2)
      expect(msg.annotations![0].url_citation.url).toBe('https://a.com')
      expect(msg.annotations![1].url_citation.title).toBe('B')
    })

    it('exposes collectedSources for timeline web search updates', () => {
      const asm = new MessageAssembler()
      asm.addAnnotation('https://a.com', 'A')

      expect(asm.collectedSources).toHaveLength(1)
      expect(asm.collectedSources[0].url).toBe('https://a.com')
    })
  })

  describe('search reasoning', () => {
    it('accumulates search reasoning', () => {
      const asm = new MessageAssembler()
      asm.addSearchReasoning('part1')
      asm.addSearchReasoning('part2')

      expect(asm.toMessage([]).searchReasoning).toBe('part1part2')
    })
  })
})
