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
  TimelineTiming,
  TimelineToolCallBlock,
  TimelineWebSearchBlock,
  ToolCallState,
  URLFetchState,
  WebSearchState,
} from '../../types'

export class TimelineBuilder {
  private blocks: TimelineBlock[] = []
  private currentThinkingIdx = -1
  private currentContentIdx = -1
  private thinkingCounter = 0

  /**
   * Start from an existing timeline so a continuation stream appends to a
   * prior response. The seed's blocks are treated as closed, except a
   * trailing content block, which stays open so new text continues it.
   *
   * When a clock is supplied, trace blocks (thinking, web search, URL
   * fetches, code exec) are stamped with startedAt/endedAt epoch ms so the
   * renderer can summarize a run of them as "Worked for N seconds".
   */
  constructor(
    seed: TimelineBlock[] = [],
    private readonly clock?: () => number,
  ) {
    this.blocks = [...seed]
    this.thinkingCounter = seed.reduce((next, block) => {
      if (block.type !== 'thinking') return next
      const match = /^thinking-(\d+)$/.exec(block.id)
      return match ? Math.max(next, Number(match[1]) + 1) : next
    }, 0)
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'content') {
      this.currentContentIdx = this.blocks.length - 1
    }
  }

  // -- Thinking -----------------------------------------------------------

  startThinking(): void {
    this.currentContentIdx = -1
    const id = `thinking-${this.thinkingCounter++}`
    this.blocks.push({
      type: 'thinking',
      id,
      content: '',
      isThinking: true,
      ...this.stampStart(),
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

  /**
   * Append a late reasoning fragment to the most recent thinking block
   * without reopening it or disturbing the current content block, so the
   * answer text keeps accumulating contiguously around it.
   */
  appendThinkingTail(text: string): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (block.type === 'thinking') {
        this.blocks[i] = {
          ...block,
          content: block.content + text,
        }
        return
      }
    }
  }

  endThinking(duration?: number): void {
    if (this.currentThinkingIdx < 0) return
    const block = this.blocks[this.currentThinkingIdx] as TimelineThinkingBlock
    this.blocks[this.currentThinkingIdx] = {
      ...block,
      isThinking: false,
      duration,
      ...this.stampEnd(),
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

  pushWebSearch(state: WebSearchState): string {
    this.finalizeThinkingForTool()
    const id = `web-search-${this.blocks.length}`
    this.blocks.push({
      type: 'web_search',
      id,
      state: { ...state },
      ...this.stampStart(),
      ...(state.status === 'searching' ? {} : this.stampEnd()),
    })
    return id
  }

  updateWebSearch(state: WebSearchState, id?: string): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (block.type === 'web_search' && (!id || block.id === id)) {
        this.blocks[i] = {
          ...block,
          state: { ...state },
          ...(state.status === 'searching' ? {} : this.stampEnd()),
        }
        break
      }
    }
  }

  getWebSearchState(id: string): WebSearchState | undefined {
    const block = this.blocks.find(
      (candidate) => candidate.type === 'web_search' && candidate.id === id,
    )
    return block?.type === 'web_search' ? { ...block.state } : undefined
  }

  findSearchingWebSearch(
    query?: string,
  ): { id: string; state: WebSearchState } | undefined {
    let uniqueMatch: { id: string; state: WebSearchState } | undefined
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (
        block.type === 'web_search' &&
        block.state.status === 'searching' &&
        (query === undefined || block.state.query === query)
      ) {
        const match = { id: block.id, state: { ...block.state } }
        if (query !== undefined) return match
        if (uniqueMatch) return undefined
        uniqueMatch = match
      }
    }
    return uniqueMatch
  }

  // -- URL Fetches --------------------------------------------------------

  addURLFetch(fetch: URLFetchState): void {
    this.finalizeThinkingForTool()
    const lastBlock = this.blocks[this.blocks.length - 1]
    if (lastBlock && lastBlock.type === 'url_fetches') {
      const exists = lastBlock.fetches.some((f) => f.id === fetch.id)
      const fetches = exists
        ? lastBlock.fetches.map((f) => (f.id === fetch.id ? fetch : f))
        : [...lastBlock.fetches, fetch]
      this.blocks[this.blocks.length - 1] = {
        ...lastBlock,
        fetches,
        ...this.stampEndIfSettled(
          fetches.every((f) => f.status !== 'fetching'),
        ),
      }
    } else {
      this.blocks.push({
        type: 'url_fetches',
        id: `url-fetches-${this.blocks.length}`,
        fetches: [fetch],
        ...this.stampStart(),
        ...this.stampEndIfSettled(fetch.status !== 'fetching'),
      })
    }
  }

  updateURLFetch(
    id: string,
    status: URLFetchState['status'],
    sources?: URLFetchState['sources'],
  ): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (
        block.type === 'url_fetches' &&
        block.fetches.some((f) => f.id === id)
      ) {
        const fetches = block.fetches.map((f) =>
          f.id === id ? { ...f, status, ...(sources ? { sources } : {}) } : f,
        )
        this.blocks[i] = {
          ...block,
          fetches,
          ...this.stampEndIfSettled(
            fetches.every((f) => f.status !== 'fetching'),
          ),
        }
        break
      }
    }
  }

  // -- GenUI Tool Calls ---------------------------------------------------

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
      if (block.type === 'tool_call' && block.toolCallId === toolCallId) {
        this.blocks[i] = {
          ...block,
          arguments: block.arguments + delta,
        }
        return
      }
    }
  }

  // -- Code Execution Tool Calls ------------------------------------------

  pushCodeExecCall(call: ToolCallState): void {
    this.finalizeThinkingForTool()
    const lastBlock = this.blocks[this.blocks.length - 1]
    if (lastBlock && lastBlock.type === 'code_exec') {
      const calls = [...lastBlock.calls, call]
      this.blocks[this.blocks.length - 1] = {
        ...lastBlock,
        calls,
        ...this.stampEndIfSettled(calls.every((c) => c.status !== 'running')),
      }
    } else {
      this.blocks.push({
        type: 'code_exec',
        id: `code-exec-${this.blocks.length}`,
        calls: [call],
        ...this.stampStart(),
        ...this.stampEndIfSettled(call.status !== 'running'),
      })
    }
  }

  updateCodeExecCall(id: string, updates: Partial<ToolCallState>): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]
      if (block.type === 'code_exec' && block.calls.some((c) => c.id === id)) {
        const calls = block.calls.map((c) =>
          c.id === id ? { ...c, ...updates } : c,
        )
        this.blocks[i] = {
          ...block,
          calls,
          ...this.stampEndIfSettled(calls.every((c) => c.status !== 'running')),
        }
        break
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

  private stampStart(): TimelineTiming {
    return this.clock ? { startedAt: this.clock() } : {}
  }

  private stampEnd(): TimelineTiming {
    return this.clock ? { endedAt: this.clock() } : {}
  }

  // Merged blocks (URL fetches, code exec) hold several items; the block
  // ends when the last in-flight item settles, so re-stamp on each settle.
  private stampEndIfSettled(settled: boolean): TimelineTiming {
    return settled ? this.stampEnd() : {}
  }

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
        isThinking: false,
        ...this.stampEnd(),
      }
      this.currentThinkingIdx = -1
    }
    this.currentContentIdx = -1
  }
}
