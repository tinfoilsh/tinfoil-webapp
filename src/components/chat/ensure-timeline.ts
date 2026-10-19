/**
 * Migration shim for old messages stored without a timeline.
 *
 * Synthesizes a TimelineBlock[] from the flat legacy fields so
 * renderers only need one code path. Once all stored messages
 * have been re-saved with timelines this file can be deleted.
 */

import type { Message, TimelineBlock } from './types'

export function ensureTimeline(msg: Message): Message {
  if (msg.role === 'user' || msg.timeline) return msg

  const blocks: TimelineBlock[] = []

  if (msg.urlFetches && msg.urlFetches.length > 0) {
    blocks.push({
      type: 'url_fetches',
      id: 'legacy-url-fetches',
      fetches: msg.urlFetches,
    })
  }

  if (msg.webSearch && msg.webSearchBeforeThinking) {
    blocks.push({
      type: 'web_search',
      id: 'legacy-web-search-pre',
      state: msg.webSearch,
    })
  }

  if (
    msg.isThinking ||
    (typeof msg.thoughts === 'string' && msg.thoughts.trim().length > 0)
  ) {
    blocks.push({
      type: 'thinking',
      id: 'legacy-thinking',
      content: msg.thoughts || '',
      isThinking: msg.isThinking ?? false,
      duration: msg.thinkingDuration,
    })
  }

  if (msg.webSearch && !msg.webSearchBeforeThinking) {
    blocks.push({
      type: 'web_search',
      id: 'legacy-web-search-post',
      state: msg.webSearch,
    })
  }

  if (msg.content) {
    blocks.push({
      type: 'content',
      id: 'legacy-content',
      content: msg.content,
    })
  }

  if (blocks.length === 0) return msg
  return { ...msg, timeline: blocks }
}
