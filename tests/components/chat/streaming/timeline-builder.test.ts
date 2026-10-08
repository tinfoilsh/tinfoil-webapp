import { TimelineBuilder } from '@/components/chat/hooks/streaming/timeline-builder'
import type {
  TimelineContentBlock,
  TimelineThinkingBlock,
  TimelineURLFetchBlock,
} from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

describe('TimelineBuilder', () => {
  describe('thinking blocks', () => {
    it('creates and closes a thinking block', () => {
      const builder = new TimelineBuilder()
      expect(builder.isThinkingOpen).toBe(false)
      builder.appendThinking('orphan')
      expect(builder.snapshot()).toEqual([])
      builder.endThinking(1.0)
      expect(builder.snapshot()).toEqual([])
      builder.startThinking()
      expect(builder.isThinkingOpen).toBe(true)
      builder.appendThinking('  hello ')
      builder.appendThinking('world  ')
      builder.endThinking(1.5)
      expect(builder.isThinkingOpen).toBe(false)
      builder.endThinking(2.0)

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      const block = blocks[0] as TimelineThinkingBlock
      expect(block.type).toBe('thinking')
      expect(block.content).toBe('  hello world  ')
      expect(block.isThinking).toBe(false)
      expect(block.duration).toBe(1.5)
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
  })

  describe('content blocks', () => {
    it('appends to existing content block', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('')
      expect(builder.snapshot()).toEqual([])
      builder.appendContent('hello')
      expect(builder.snapshot()).toEqual([
        { type: 'content', id: 'content-0', content: 'hello' },
      ])
      builder.appendContent('')
      builder.appendContent(' world')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('content')
      expect((blocks[0] as TimelineContentBlock).content).toBe('hello world')
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
    it('updates the most recent web search block', () => {
      const builder = new TimelineBuilder()
      builder.pushWebSearch({ query: 'first', status: 'searching' })
      expect(builder.snapshot()).toEqual([
        {
          type: 'web_search',
          id: 'web-search-0',
          state: { query: 'first', status: 'searching' },
        },
      ])
      builder.appendContent('between')
      builder.pushWebSearch({ query: 'second', status: 'searching' })
      builder.updateWebSearch({
        query: 'second',
        status: 'completed',
        sources: [{ title: 'Result', url: 'https://example.com' }],
      })

      expect(builder.snapshot()).toEqual([
        {
          type: 'web_search',
          id: 'web-search-0',
          state: { query: 'first', status: 'searching' },
        },
        { type: 'content', id: 'content-1', content: 'between' },
        {
          type: 'web_search',
          id: 'web-search-2',
          state: {
            query: 'second',
            status: 'completed',
            sources: [{ title: 'Result', url: 'https://example.com' }],
          },
        },
      ])
    })

    it('finalizes open thinking when web search arrives', () => {
      const builder = new TimelineBuilder()
      builder.startThinking()
      builder.appendThinking('  spaced for tool  ')
      expect(builder.isThinkingOpen).toBe(true)

      builder.pushWebSearch({ query: 'q', status: 'searching' })
      expect(builder.isThinkingOpen).toBe(false)

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(2)
      expect((blocks[0] as TimelineThinkingBlock).isThinking).toBe(false)
      expect((blocks[0] as TimelineThinkingBlock).content).toBe(
        '  spaced for tool  ',
      )
      expect(blocks[1].type).toBe('web_search')
    })
  })

  describe('URL fetch blocks', () => {
    it('groups consecutive URL fetches into the same block', () => {
      const builder = new TimelineBuilder()
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com',
        status: 'fetching',
      })
      expect(builder.snapshot()).toEqual([
        {
          type: 'url_fetches',
          id: 'url-fetches-0',
          fetches: [{ id: 'f1', url: 'https://a.com', status: 'fetching' }],
        },
      ])
      builder.addURLFetch({
        id: 'f2',
        url: 'https://b.com',
        status: 'fetching',
      })

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as TimelineURLFetchBlock).fetches).toEqual([
        { id: 'f1', url: 'https://a.com', status: 'fetching' },
        { id: 'f2', url: 'https://b.com', status: 'fetching' },
      ])
      builder.addURLFetch({
        id: 'f1',
        url: 'https://a.com/redirected',
        status: 'completed',
      })
      builder.appendContent('between')
      builder.addURLFetch({
        id: 'f3',
        url: 'https://c.com',
        status: 'fetching',
      })
      expect(builder.snapshot()).toEqual([
        {
          type: 'url_fetches',
          id: 'url-fetches-0',
          fetches: [
            { id: 'f1', url: 'https://a.com/redirected', status: 'completed' },
            { id: 'f2', url: 'https://b.com', status: 'fetching' },
          ],
        },
        { type: 'content', id: 'content-1', content: 'between' },
        {
          type: 'url_fetches',
          id: 'url-fetches-2',
          fetches: [{ id: 'f3', url: 'https://c.com', status: 'fetching' }],
        },
      ])
    })

    it.each([
      { target: 'f1', statuses: ['completed', 'fetching', 'fetching'] },
      { target: 'f2', statuses: ['fetching', 'completed', 'fetching'] },
      { target: 'f3', statuses: ['fetching', 'fetching', 'completed'] },
      { target: 'missing', statuses: ['fetching', 'fetching', 'fetching'] },
    ])('updates only the requested fetch ($target)', ({ target, statuses }) => {
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
      builder.appendContent('between')
      builder.addURLFetch({
        id: 'f3',
        url: 'https://c.com',
        status: 'fetching',
      })
      const sources = [{ title: 'Result', url: 'https://result.com' }]
      builder.updateURLFetch(target, 'completed', sources)

      const fetches = builder
        .snapshot()
        .flatMap((block) => (block.type === 'url_fetches' ? block.fetches : []))
      expect(fetches).toEqual([
        {
          id: 'f1',
          url: 'https://a.com',
          status: statuses[0],
          sources: statuses[0] === 'completed' ? sources : undefined,
        },
        {
          id: 'f2',
          url: 'https://b.com',
          status: statuses[1],
          sources: statuses[1] === 'completed' ? sources : undefined,
        },
        {
          id: 'f3',
          url: 'https://c.com',
          status: statuses[2],
          sources: statuses[2] === 'completed' ? sources : undefined,
        },
      ])
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

  describe('seeded continuation', () => {
    it('appends new text to a trailing seed content block', () => {
      const builder = new TimelineBuilder([
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
        { type: 'content', id: 'content-1', content: 'Half of' },
      ])
      builder.appendContent(' an answer')

      const blocks = builder.snapshot()
      expect(blocks).toHaveLength(2)
      expect((blocks[1] as TimelineContentBlock).content).toBe(
        'Half of an answer',
      )
    })

    it('starts a fresh content block when new thinking follows the seed', () => {
      const builder = new TimelineBuilder([
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'hmm',
          isThinking: false,
        },
        { type: 'content', id: 'content-1', content: 'Half of' },
      ])
      builder.startThinking()
      builder.appendThinking('more')
      builder.endThinking()
      builder.appendContent(' an answer')

      const blocks = builder.snapshot()
      expect(blocks.map((b) => b.type)).toEqual([
        'thinking',
        'content',
        'thinking',
        'content',
      ])
      expect((blocks[2] as TimelineThinkingBlock).id).toBe('thinking-1')
      expect((blocks[1] as TimelineContentBlock).content).toBe('Half of')
      expect((blocks[3] as TimelineContentBlock).content).toBe(' an answer')
    })

    it('does not mutate the seed array', () => {
      const seed: TimelineContentBlock[] = [
        { type: 'content', id: 'content-0', content: 'seed' },
      ]
      const builder = new TimelineBuilder(seed)
      builder.appendContent(' more')
      builder.startThinking()
      builder.endThinking()
      builder.appendContent('new block')

      expect(builder.snapshot()).toEqual([
        { type: 'content', id: 'content-0', content: 'seed more' },
        {
          type: 'thinking',
          id: 'thinking-0',
          content: '',
          isThinking: false,
          duration: undefined,
        },
        { type: 'content', id: 'content-2', content: 'new block' },
      ])
      expect(seed).toEqual([
        { type: 'content', id: 'content-0', content: 'seed' },
      ])
    })

    it('continues thinking ids past non-contiguous seed ids', () => {
      const builder = new TimelineBuilder([
        { type: 'thinking', id: 'thinking-0', content: 'a', isThinking: false },
        { type: 'thinking', id: 'thinking-2', content: 'b', isThinking: false },
      ])
      builder.startThinking()

      expect(builder.snapshot().at(-1)?.id).toBe('thinking-3')
    })
  })

  describe('snapshot immutability', () => {
    it('returns a new array each time', () => {
      const builder = new TimelineBuilder()
      builder.appendContent('test')
      const s1 = builder.snapshot()
      const s2 = builder.snapshot()
      expect(s1).toEqual([
        { type: 'content', id: 'content-0', content: 'test' },
      ])
      expect(s2).toEqual([
        { type: 'content', id: 'content-0', content: 'test' },
      ])
      expect(s1).not.toBe(s2)
      builder.appendContent(' more')
      expect(builder.snapshot()).toEqual([
        { type: 'content', id: 'content-0', content: 'test more' },
      ])
      expect(s1).toEqual([
        { type: 'content', id: 'content-0', content: 'test' },
      ])
      expect(s2).toEqual([
        { type: 'content', id: 'content-0', content: 'test' },
      ])
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
      expect(
        builder.snapshot().filter((block) => block.type === 'thinking'),
      ).toEqual([
        {
          type: 'thinking',
          id: 'thinking-0',
          content: 'first thought',
          isThinking: false,
          duration: 1.0,
        },
        {
          type: 'thinking',
          id: 'thinking-1',
          content: 'second thought',
          isThinking: false,
          duration: 0.5,
        },
      ])
    })
  })
})
