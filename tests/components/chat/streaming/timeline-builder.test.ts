import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
import type {
  TimelineContentBlock,
  TimelineThinkingBlock,
  TimelineURLFetchBlock,
  TimelineWebSearchBlock,
} from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

describe('TimelineBuilder', () => {
  describe('thinking blocks', () => {
    it('creates and closes a thinking block', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('hello ')
      builder.appendThinking('world')
      builder.endThinking(1.5)

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      const block = blocks[0] as TimelineThinkingBlock
      expect(block.type).toBe('thinking')
      expect(block.content).toBe('hello world')
      expect(block.isThinking).toBe(false)
      expect(block.duration).toBe(1.5)
    })

    it('trims thinking content on end', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('  spaced  ')
      builder.endThinking()

      const block = builder.snapshot()[0] as TimelineThinkingBlock
      expect(block.content).toBe('spaced')
    })

    it('tracks isThinkingOpen correctly', () => {
      const builder = new TimelineBuilder()
      expect(builder.isThinkingOpen).toBe(false)

      builder.startThinking()
      expect(builder.isThinkingOpen).toBe(true)

      builder.endThinking()
      expect(builder.isThinkingOpen).toBe(false)
    })

    it('handles multiple thinking blocks', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('first')
      builder.endThinking(1.0)

      builder.startThinking()
      builder.appendThinking('second')
      builder.endThinking(2.0)

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(2)
      expect((blocks[0] as TimelineThinkingBlock).content).toBe('first')
      expect((blocks[1] as TimelineThinkingBlock).content).toBe('second')
    })

    it('ignores appendThinking when no block is open', () => {
      const builder = new TimelineBuilder()
      builder.appendThinking('orphan')
      expect(builder.snapshot()).toEqual([])
    })

    it('appends a tail to the closed thinking block without splitting content', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('I should account')
      builder.endThinking(1.1)
      builder.appendContent('The')
      builder.appendThinkingTail(' for.')
      builder.appendContent(' main things were:')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(2)
      const thinking = blocks[0] as TimelineThinkingBlock
      expect(thinking.content).toBe('I should account for.')
      expect(thinking.isThinking).toBe(false)
      expect(thinking.duration).toBe(1.1)
      const content = blocks[1] as TimelineContentBlock
      expect(content.content).toBe('The main things were:')
    })

    it('ignores appendThinkingTail when no thinking block exists', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('hello')
      builder.appendThinkingTail('orphan tail')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as TimelineContentBlock).content).toBe('hello')
    })

    it('ignores endThinking when no block is open', () => {
      const builder = new TimelineBuilder()
      // Should not throw
      builder.endThinking(1.0)
      expect(builder.snapshot()).toEqual([])
    })
  })

  describe('content blocks', () => {
    it('creates a content block on first append', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('hello')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('content')
      expect((blocks[0] as TimelineContentBlock).content).toBe('hello')
    })

    it('appends to existing content block', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('hello')
      builder.appendContent(' world')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as TimelineContentBlock).content).toBe('hello world')
    })

    it('ignores empty strings', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('')
      expect(builder.snapshot()).toEqual([])
    })

    it('creates a new content block after thinking', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('before')
      builder.startThinking()
      builder.appendThinking('thought')
      builder.endThinking()
      builder.appendContent('after')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(3)
      expect(blocks[0].type).toBe('content')
      expect(blocks[1].type).toBe('thinking')
      expect(blocks[2].type).toBe('content')
      expect((blocks[0] as TimelineContentBlock).content).toBe('before')
      expect((blocks[2] as TimelineContentBlock).content).toBe('after')
    })
  })

  describe('web search blocks', () => {
    it('pushes a web search block', () => {
      const builder = new TimelineBuilder()
      builder.pushWebSearch({ query: 'test', status: 'searching' })

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('web_search')
      expect((blocks[0] as TimelineWebSearchBlock).state.query).toBe('test')
    })

    it('updates the most recent web search block', () => {
      const builder = new TimelineBuilder()
      builder.pushWebSearch({ query: 'test', status: 'searching' })
      builder.updateWebSearch({
        query: 'test',
        status: 'completed',
        sources: [{ title: 'Result', url: 'https://example.com' }],
      })

      const block = builder.snapshot()[0] as TimelineWebSearchBlock
      expect(block.state.status).toBe('completed')
      expect(block.state.sources).toHaveLength(1)
    })

    it('finalizes open thinking when web search arrives', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('mid-thought')
      expect(builder.isThinkingOpen).toBe(true)

      builder.pushWebSearch({ query: 'q', status: 'searching' })
      expect(builder.isThinkingOpen).toBe(false)

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(2)
      expect((blocks[0] as TimelineThinkingBlock).isThinking).toBe(false)
      expect(blocks[1].type).toBe('web_search')
    })
  })

  describe('URL fetch blocks', () => {
    it('adds a URL fetch to a new block', () => {
      const builder = new TimelineBuilder()
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('url_fetches')
      expect((blocks[0] as TimelineURLFetchBlock).fetches).toHaveLength(1)
    })

    it('groups consecutive URL fetches into the same block', () => {
      const builder = new TimelineBuilder()
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })
      builder.addURLFetch({
        id: 'f2',
        url: 'https://b.com',
        status: 'fetching',
      })

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as TimelineURLFetchBlock).fetches).toHaveLength(2)
    })

    it('updates a specific fetch by id', () => {
      const builder = new TimelineBuilder()
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })
      builder.addURLFetch({
        id: 'f2',
        url: 'https://b.com',
        status: 'fetching',
      })
      builder.updateURLFetch('f1', 'completed')

      const fetches = (builder.snapshot()[0] as TimelineURLFetchBlock).fetches
      expect(fetches[0].status).toBe('completed')
      expect(fetches[1].status).toBe('fetching')
    })

    it('finalizes open thinking when URL fetch arrives', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('thought')
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })

      expect(builder.isThinkingOpen).toBe(false)
      const blocks = builder.snapshot()
      expect(blocks[0].type).toBe('thinking')
      expect(blocks[1].type).toBe('url_fetches')
    })
  })

  describe('snapshot immutability', () => {
    it('returns a new array each time', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('test')
      const s1 = builder.snapshot()
      const s2 = builder.snapshot()
      expect(s1).toEqual(s2)
      expect(s1).not.toBe(s2)
    })
  })

  describe('chronological interleaving', () => {
    it('maintains correct order: think → search → think → content', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('first thought')
      builder.endThinking(1.0)

      builder.pushWebSearch({ query: 'q', status: 'searching' })
      builder.updateWebSearch({ query: 'q', status: 'completed', sources: [] })

      builder.startThinking()
      builder.appendThinking('second thought')
      builder.endThinking(0.5)

      builder.appendContent('the answer')

      const types = builder.snapshot().map((b) => b.type)
      expect(types).toEqual(['thinking', 'web_search', 'thinking', 'content'])
    })
  })
})
