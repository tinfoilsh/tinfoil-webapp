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
      expect(msg.timeline).toEqual(timeline)
      expect(msg.timeline).not.toBe(timeline)
    })

    it('stores the model display name on the message', () => {
      const asm = new MessageAssembler('Kimi K2.6')

      expect(asm.toMessage([]).modelDisplayName).toBe('Kimi K2.6')
    })

    it.each([false, true])(
      'derives thoughts from thinking blocks (active: %s)',
      (isThinking) => {
        const asm = new MessageAssembler()
        const timeline: TimelineBlock[] = [
          {
            type: 'thinking',
            id: 'thinking-0',
            content: 'let me think',
            isThinking,
            duration: isThinking ? undefined : 2.5,
          },
        ]

        const msg = asm.toMessage(timeline)
        expect(msg.thoughts).toBe('let me think')
        expect(msg.isThinking).toBe(isThinking)
        expect(msg.thinkingDuration).toBe(isThinking ? undefined : 2.5)
      },
    )

    it('uses last web_search block for webSearch state', () => {
      const asm = new MessageAssembler()
      const timeline: TimelineBlock[] = [
        {
          type: 'web_search',
          id: 'ws-0',
          state: { query: 'first', status: 'searching' },
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

      expect(asm.toMessage(timeline.slice(0, 1)).webSearch).toEqual({
        query: 'first',
        status: 'searching',
      })
      const msg = asm.toMessage(timeline)
      expect(msg.webSearch).toEqual({
        query: 'second',
        status: 'completed',
        sources: [{ url: 'https://a.com', title: 'A' }],
      })
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
        { type: 'content', id: 'c-1', content: 'between' },
        {
          type: 'url_fetches',
          id: 'uf-2',
          fetches: [{ id: 'f3', url: 'https://c.com', status: 'failed' }],
        },
      ]

      const msg = asm.toMessage(timeline)
      expect(msg.urlFetches).toEqual([
        { id: 'f1', url: 'https://a.com', status: 'completed' },
        { id: 'f2', url: 'https://b.com', status: 'fetching' },
        { id: 'f3', url: 'https://c.com', status: 'failed' },
      ])
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

    it.each<{ label: string; timeline: TimelineBlock[] }>([
      { label: 'empty', timeline: [] },
      {
        label: 'plain content',
        timeline: [{ type: 'content', id: 'c', content: 'plain' }],
      },
    ])(
      'omits optional fields without matching timeline blocks ($label)',
      ({ timeline }) => {
        const asm = new MessageAssembler()
        const msg = asm.toMessage(timeline)
        expect(msg.thoughts).toBeUndefined()
        expect(msg.webSearch).toBeUndefined()
        expect(msg.urlFetches).toBeUndefined()
        expect(msg.annotations).toBeUndefined()
        expect(msg.searchReasoning).toBeUndefined()
        expect(msg.toolCalls).toBeUndefined()
        expect(msg.codeExecCalls).toBeUndefined()
      },
    )

    it('preserves an explicitly empty reasoning value', () => {
      const asm = new MessageAssembler()
      const msg = asm.toMessage([
        {
          type: 'thinking',
          id: 'thinking-0',
          content: '',
          isThinking: false,
        },
      ])

      expect(msg.thoughts).toBe('')
    })
  })

  describe('annotations', () => {
    it('collects annotations via addAnnotation', () => {
      const asm = new MessageAssembler()
      asm.addAnnotation('https://a.com', 'A')
      asm.addAnnotation('https://b.com', 'B')

      const msg = asm.toMessage([])
      expect(msg.annotations).toEqual([
        {
          type: 'url_citation',
          url_citation: { url: 'https://a.com', title: 'A' },
        },
        {
          type: 'url_citation',
          url_citation: { url: 'https://b.com', title: 'B' },
        },
      ])
      expect(asm.collectedSources).toEqual([
        { url: 'https://a.com', title: 'A' },
        { url: 'https://b.com', title: 'B' },
      ])
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
