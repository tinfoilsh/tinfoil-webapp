import { RichStreamSession } from '@/components/chat/hooks/streaming/rich-stream-session'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import { sanitizeNativeBackupChat } from '@/services/native-backup/sanitize'
import {
  estimateMessageTokens,
  selectMessagesWithinBudget,
} from '@/utils/token-estimation'
import {
  WEB_SEARCH_HISTORY_LIMIT,
  WEB_SEARCH_HISTORY_SNIPPET_LIMIT,
  webSearchHistoryMessages,
} from '@/utils/web-search-history'
import { describe, expect, it } from 'vitest'

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  name: 'GPT-OSS',
  nameShort: 'GPT-OSS',
  image: '',
  description: '',
  type: 'chat',
  chat: true,
}
const url = 'https://example.com/paper?edition=2#results'
const excerpt = 'The retrieved paper reports a sample of 73 participants.'
const source = { title: 'Paper', url, snippet: excerpt }
const message = (): Message => ({
  role: 'assistant',
  content: 'The paper reports 73 participants.',
  timestamp: new Date('2026-09-01T00:00:00Z'),
  webSearch: { query: 'sample size', status: 'completed', sources: [source] },
})

function marker(session: RichStreamSession, event: object) {
  const text =
    '\n<tinfoil-event>' +
    JSON.stringify({ type: 'tinfoil.web_search_call', ...event }) +
    '</tinfoil-event>\n'
  for (const content of [text.slice(0, 17), text.slice(17)]) {
    session.processChunk({ choices: [{ delta: { content } }] })
  }
}

describe('saved web evidence', () => {
  it('continues collecting annotations when legacy events have no excerpts', () => {
    const session = new RichStreamSession()
    marker(session, {
      item_id: 'legacy',
      status: 'completed',
      action: { type: 'search', query: 'legacy' },
    })
    const urls = [url, 'https://example.com/another']
    for (const citedURL of urls) {
      session.processChunk({
        choices: [
          {
            delta: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: citedURL, title: 'Paper' },
                },
              ],
            },
          },
        ],
      })
    }
    expect(
      session.snapshot().webSearch?.sources?.map((source) => source.url),
    ).toEqual(urls)
    expect(webSearchHistoryMessages(session.snapshot(), 0)).toEqual([])
  })

  it('survives streaming, citation updates, backup, and six user turns', () => {
    const history: Message[] = []
    const turns = 6
    for (let turn = 0; turn < turns; turn++) {
      const session = new RichStreamSession()
      const action = { type: 'search', query: `sample size ${turn}` }
      marker(session, {
        item_id: `search-${turn}`,
        status: 'in_progress',
        action,
      })
      marker(session, {
        item_id: `search-${turn}`,
        status: 'completed',
        action,
        sources: [source],
      })
      session.processChunk({
        choices: [
          {
            delta: {
              content: 'Answer.',
              annotations: [
                { type: 'url_citation', url_citation: { url, title: 'Paper' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      })
      const completed = session.complete()
      expect(completed.webSearch?.sources?.[0].snippet).toBe(excerpt)
      const backup = sanitizeNativeBackupChat({
        id: 'chat',
        title: 'Research',
        createdAt: completed.timestamp,
        messages: [completed],
      })
      const restored = {
        ...backup.messages[0],
        timestamp: new Date(backup.messages[0].timestamp),
      } as Message
      history.push(
        {
          role: 'user',
          content: `Research ${turn}`,
          timestamp: completed.timestamp,
        },
        restored,
      )
      const request = ChatQueryBuilder.buildMessages({
        model,
        systemPrompt: 'Be helpful.',
        messages: [
          ...history,
          {
            role: 'user',
            content: 'Find another source.',
            timestamp: completed.timestamp,
          },
        ],
      })
      const toolResults = request.filter((item) => item.role === 'tool')
      expect(toolResults).toHaveLength(turn + 1)
      expect(
        toolResults.every(
          (item) =>
            typeof item.content === 'string' &&
            JSON.parse(item.content).sources[0].snippet === excerpt,
        ),
      ).toBe(true)
      const ids = new Set(toolResults.map((item) => item.tool_call_id))
      expect(ids.size).toBe(turn + 1)
      for (let i = 0; i < request.length; i++) {
        if (request[i].role !== 'tool') continue
        expect(request[i - 1]).toMatchObject({
          role: 'assistant',
          tool_calls: [
            { id: (request[i] as { tool_call_id: string }).tool_call_id },
          ],
        })
      }
      expect(request.filter((item) => item.role === 'system')).toEqual([
        { role: 'system', content: 'Be helpful.' },
      ])
    }
  })

  it('retains fetched excerpts under the correct URL', () => {
    const session = new RichStreamSession()
    const action = { type: 'open_page', url }
    marker(session, { item_id: 'fetch', status: 'in_progress', action })
    marker(session, {
      item_id: 'fetch',
      status: 'completed',
      action,
      sources: [
        source,
        { ...source, url: 'https://other.example', snippet: 'Wrong page' },
      ],
    })
    session.processChunk({
      choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }],
    })
    const completed = session.complete()
    const replay = webSearchHistoryMessages(completed, 0)
    expect(replay[0]).toMatchObject({
      tool_calls: [
        {
          function: {
            name: 'router_fetch',
            arguments: JSON.stringify({ urls: [url] }),
          },
        },
      ],
    })
    expect(JSON.parse(replay[1].content as string).sources).toEqual([source])
    const backup = sanitizeNativeBackupChat({
      id: 'chat',
      title: 'Fetch',
      createdAt: completed.timestamp,
      messages: [completed],
    })
    expect(backup.messages[0].urlFetches?.[0].sources?.[0].snippet).toBe(
      excerpt,
    )
  })

  it('does not reconstruct searches from prose, annotations, failures, or old URL-only events', () => {
    const original = message()
    for (const candidate of [
      { ...original, role: 'user' as const },
      {
        ...original,
        webSearch: undefined,
        annotations: [
          {
            type: 'url_citation' as const,
            url_citation: { title: 'Paper', url },
          },
        ],
      },
      ...(['failed', 'blocked', 'searching'] as const).map((status) => ({
        ...original,
        webSearch: { ...original.webSearch!, status },
      })),
      {
        ...original,
        webSearch: {
          ...original.webSearch!,
          sources: [{ title: 'Paper', url }],
        },
      },
    ])
      expect(webSearchHistoryMessages(candidate, 0)).toEqual([])
  })

  it('bounds replay, prioritizes recent evidence, and accounts for it before archiving', () => {
    const original = message()
    original.timeline = Array.from({ length: 20 }, (_, index) => ({
      type: 'web_search',
      id: `search-${index}`,
      state: {
        query: `query-${index}`,
        status: 'completed',
        sources: Array.from({ length: 8 }, (_, n) => ({
          ...source,
          url: `${url}-${n}`,
          snippet: '🔎'.repeat(2000),
        })),
      },
    }))
    const replay = webSearchHistoryMessages(original, 2)
    expect(replay.length).toBeGreaterThan(0)
    expect(JSON.stringify(replay).length).toBeLessThanOrEqual(
      WEB_SEARCH_HISTORY_LIMIT,
    )
    expect(JSON.stringify(replay)).toContain('query-19')
    for (const result of replay.filter((item) => item.role === 'tool')) {
      for (const retained of JSON.parse(result.content as string).sources) {
        expect(retained.snippet.length).toBeLessThanOrEqual(
          WEB_SEARCH_HISTORY_SNIPPET_LIMIT,
        )
        expect(retained.snippet).toContain('[Excerpt truncated]')
        expect(retained.snippet).not.toContain('\uFFFD')
      }
    }
    expect(estimateMessageTokens(original)).toBeGreaterThan(
      estimateMessageTokens({
        ...original,
        timeline: undefined,
        webSearch: undefined,
      }),
    )
    const latest: Message = {
      role: 'user',
      content: 'Continue.',
      timestamp: original.timestamp,
    }
    expect(selectMessagesWithinBudget([original, latest], 100)).toEqual([
      latest,
    ])
  })
})
