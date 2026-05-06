/**
 * Tracks citation annotations and search reasoning during streaming.
 *
 * All other flat Message fields (content, thoughts, webSearch, urlFetches,
 * etc.) are derived from the TimelineBlock[] in toMessage() — the timeline
 * is the single source of truth.
 */

import type {
  Annotation,
  Message,
  TimelineBlock,
  URLFetchState,
  WebSearchSource,
  WebSearchState,
} from '../../types'

export class MessageAssembler {
  private annotations: Annotation[] = []
  // Frozen snapshot of `annotations` shared across every toMessage() call
  // until a new annotation is added. Reusing the same reference lets
  // downstream React memos (e.g. citationUrlTitles) skip rebuilding while
  // streaming tokens arrive, which prevents citation pill favicons from
  // remounting and flashing on every chunk.
  private annotationsSnapshot: Annotation[] | undefined
  private sources: WebSearchSource[] = []
  private searchReasoning = ''
  private timestamp = new Date()

  addAnnotation(url: string, title: string): void {
    this.sources.push({ title, url })
    this.annotations.push({
      type: 'url_citation',
      url_citation: { title, url },
    })
    this.annotationsSnapshot = undefined
  }

  addSearchReasoning(content: string): void {
    this.searchReasoning += content
  }

  get collectedSources(): WebSearchSource[] {
    return this.sources
  }

  toMessage(timeline: TimelineBlock[]): Message {
    let content = ''
    let thoughts = ''
    let isThinking = false
    let thinkingDuration: number | undefined
    let webSearch: WebSearchState | undefined
    let webSearchBeforeThinking: boolean | undefined
    const urlFetches: URLFetchState[] = []
    const toolCalls: Message['toolCalls'] = []
    let firstThinkingIdx = -1
    let firstWebSearchIdx = -1

    for (let i = 0; i < timeline.length; i++) {
      const block = timeline[i]
      switch (block.type) {
        case 'thinking':
          if (firstThinkingIdx < 0) firstThinkingIdx = i
          thoughts += block.content
          if (block.isThinking) isThinking = true
          if (block.duration !== undefined) thinkingDuration = block.duration
          break
        case 'content':
          content += block.content
          break
        case 'web_search':
          if (firstWebSearchIdx < 0) firstWebSearchIdx = i
          webSearch = block.state
          break
        case 'url_fetches':
          urlFetches.push(...block.fetches)
          break
        case 'tool_call':
          toolCalls.push({
            id: block.toolCallId,
            name: block.name,
            arguments: block.arguments,
          })
          break
      }
    }

    if (firstWebSearchIdx >= 0) {
      webSearchBeforeThinking =
        firstThinkingIdx < 0 || firstWebSearchIdx < firstThinkingIdx
    }

    return {
      role: 'assistant',
      content,
      timestamp: this.timestamp,
      thoughts: thoughts || undefined,
      isThinking,
      thinkingDuration,
      webSearch,
      webSearchBeforeThinking: webSearchBeforeThinking || undefined,
      urlFetches: urlFetches.length > 0 ? urlFetches : undefined,
      annotations: this.getAnnotationsSnapshot(),
      searchReasoning: this.searchReasoning || undefined,
      timeline: [...timeline],
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    }
  }

  private getAnnotationsSnapshot(): Annotation[] | undefined {
    if (this.annotations.length === 0) return undefined
    if (!this.annotationsSnapshot) {
      this.annotationsSnapshot = [...this.annotations]
    }
    return this.annotationsSnapshot
  }
}
