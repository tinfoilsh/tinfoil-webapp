/**
 * Manages the chronological TimelineBlock[] array.
 *
 * Pure state — no React, no side effects, fully unit-testable.
 * The processor calls explicit methods; the builder handles all the
 * index-tracking and block-creation logic internally.
 */

import type {
  TimelineBlock,
  TimelineContentBlock,
  TimelineThinkingBlock,
  TimelineToolCallBlock,
  TimelineWebSearchBlock,
  URLFetchState,
  WebSearchState,
} from '../../types'

export class TimelineBuilder {
  private blocks: TimelineBlock[] = []
  private currentThinkingIdx = -1
  private currentContentIdx = -1
  private thinkingCounter = 0

  // -- Thinking -----------------------------------------------------------

  startThinking(): void {
    this.currentContentIdx = -1
    const id = `thinking-${this.thinkingCounter++}`
    this.blocks.push({
      type: 'thinking',
      id,
      content: '',
      isThinking: true,
    })
    this.currentThinkingIdx = this.blocks.length - 1
  }

  appendThinking(text: string): void {
    if (this.currentThinkingIdx < 0) return
    const block = this.blocks[this.currentThinkingIdx] as TimelineThinkingBlock
    this.blocks[this.currentThinkingIdx] = {
      ...block,
      content: block.content + text,
    }
  }

  endThinking(duration?: number): void {
    if (this.currentThinkingIdx < 0) return
    const block = this.blocks[this.currentThinkingIdx] as TimelineThinkingBlock
    this.blocks[this.currentThinkingIdx] = {
      ...block,
      content: block.content.trim(),
      isThinking: false,
      duration,
    }
    this.currentThinkingIdx = -1
    this.currentContentIdx = -1
  }

  get isThinkingOpen(): boolean {
    return this.currentThinkingIdx >= 0
  }

  // -- Content ------------------------------------------------------------

  appendContent(text: string): void {
    if (!text) return
    if (this.currentContentIdx >= 0) {
      const block = this.blocks[this.currentContentIdx] as TimelineContentBlock
      this.blocks[this.currentContentIdx] = {
        ...block,
        content: block.content + text,
      }
    } else {
      this.blocks.push({
        type: 'content',
        id: `content-${this.blocks.length}`,
        content: text,
      })
      this.currentContentIdx = this.blocks.length - 1
    }
  }

  // -- Web Search ---------------------------------------------------------

  pushWebSearch(state: WebSearchState): void {
    this.finalizeThinkingForTool()
    this.blocks.push({
      type: 'web_search',
      id: `web-search-${this.blocks.length}`,
      state: { ...state },
    })
  }

  updateWebSearch(state: WebSearchState): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].type === 'web_search') {
        this.blocks[i] = {
          ...this.blocks[i],
          state: { ...state },
        } as TimelineBlock
        break
      }
    }
  }

  // -- URL Fetches --------------------------------------------------------

  addURLFetch(fetch: URLFetchState): void {
    this.finalizeThinkingForTool()
    const lastBlock = this.blocks[this.blocks.length - 1]
    if (lastBlock && lastBlock.type === 'url_fetches') {
      const exists = lastBlock.fetches.some((f) => f.id === fetch.id)
      this.blocks[this.blocks.length - 1] = {
        ...lastBlock,
        fetches: exists
          ? lastBlock.fetches.map((f) => (f.id === fetch.id ? fetch : f))
          : [...lastBlock.fetches, fetch],
      }
    } else {
      this.blocks.push({
        type: 'url_fetches',
        id: `url-fetches-${this.blocks.length}`,
        fetches: [fetch],
      })
    }
  }

  updateURLFetch(id: string, status: URLFetchState['status']): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (
        block.type === 'url_fetches' &&
        block.fetches.some((f) => f.id === id)
      ) {
        this.blocks[i] = {
          ...block,
          fetches: block.fetches.map((f) =>
            f.id === id ? { ...f, status } : f,
          ),
        }
        break
      }
    }
  }

  // -- Tool Calls ---------------------------------------------------------

  startToolCall(toolCallId: string, name: string): void {
    this.finalizeThinkingForTool()
    const block: TimelineToolCallBlock = {
      type: 'tool_call',
      id: `tool-call-${this.blocks.length}`,
      toolCallId,
      name,
      arguments: '',
    }
    this.blocks.push(block)
  }

  appendToolCallArguments(toolCallId: string, delta: string): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (
        block.type === 'tool_call' &&
        (block as TimelineToolCallBlock).toolCallId === toolCallId
      ) {
        const existing = block as TimelineToolCallBlock
        this.blocks[i] = {
          ...existing,
          arguments: existing.arguments + delta,
        }
        return
      }
    }
  }

  resolveToolCall(
    toolCallId: string,
    resolution: { text: string; data?: unknown; resolvedAt: number },
  ): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (
        block.type === 'tool_call' &&
        (block as TimelineToolCallBlock).toolCallId === toolCallId
      ) {
        const existing = block as TimelineToolCallBlock
        this.blocks[i] = {
          ...existing,
          resolvedAt: resolution.resolvedAt,
          resolution: { text: resolution.text, data: resolution.data },
        }
        return
      }
    }
  }

  // -- Query --------------------------------------------------------------

  getLastWebSearchState(): WebSearchState | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].type === 'web_search') {
        return { ...(this.blocks[i] as TimelineWebSearchBlock).state }
      }
    }
    return undefined
  }

  // -- Snapshot -----------------------------------------------------------

  snapshot(): TimelineBlock[] {
    return [...this.blocks]
  }

  // -- Internal -----------------------------------------------------------

  /**
   * Close any active thinking block so tool blocks (web search, URL fetch)
   * appear after it chronologically.
   */
  private finalizeThinkingForTool(): void {
    if (this.currentThinkingIdx >= 0) {
      const block = this.blocks[
        this.currentThinkingIdx
      ] as TimelineThinkingBlock
      this.blocks[this.currentThinkingIdx] = {
        ...block,
        content: block.content.trim(),
        isThinking: false,
      }
      this.currentThinkingIdx = -1
    }
    this.currentContentIdx = -1
  }
}
