import type { ChatChunk } from '@/services/inference/chat-stream'
import type { StreamLogger } from '@/utils/dev-stream-logger'
import type { Message, URLFetchState } from '../../types'
import { createContentPreprocessor } from './content-preprocessor'
import { createEventNormalizer } from './event-normalizer'
import { finalizeInterruptedMessage } from './interrupted-message'
import { MessageAssembler } from './message-assembler'
import { TimelineBuilder } from './timeline-builder'
import type { NormalizedEvent } from './types'

interface RichStreamSessionOptions {
  trackThinkingDuration?: boolean
  onFirstEvent?: () => void
  onThinkingChange?: (isThinking: boolean) => void
  modelDisplayName?: string
  resolveModelDisplayName?: (modelName: string) => string | undefined
}

export class RichStreamSession {
  private readonly preprocessor = createContentPreprocessor()
  private readonly normalizer = createEventNormalizer()
  private readonly timeline = new TimelineBuilder()
  private readonly assembler: MessageAssembler
  private readonly webSearchBlocks = new Map<string, string>()
  private firstEventSeen = false
  private changed = false
  private thinkingStartedAt: number | null = null

  constructor(private readonly options: RichStreamSessionOptions = {}) {
    this.assembler = new MessageAssembler(options.modelDisplayName)
  }

  processChunk(chunk: ChatChunk, streamLogger?: StreamLogger): boolean {
    const resolvedModelDisplayName =
      typeof chunk.model === 'string'
        ? this.options.resolveModelDisplayName
          ? this.options.resolveModelDisplayName(chunk.model)
          : chunk.model
        : undefined
    const modelChanged =
      resolvedModelDisplayName !== undefined &&
      this.assembler.setModelDisplayName(resolvedModelDisplayName)
    const events = this.normalizer.processChunk(
      chunk,
      this.preprocessor,
      streamLogger,
    )
    for (const event of events) this.applyEvent(event)
    if (modelChanged) this.changed = true
    return modelChanged || events.length > 0
  }

  snapshot(turnId?: string): Message {
    return { ...this.assembler.toMessage(this.timeline.snapshot()), turnId }
  }

  get hasChanges(): boolean {
    return this.changed
  }

  complete(turnId?: string): Message {
    this.normalizer.assertComplete()
    this.flushBufferedTail()
    this.closeOpenThinking()
    return this.snapshot(turnId)
  }

  interruptedSnapshot(turnId?: string): Message {
    this.flushBufferedTail()
    return finalizeInterruptedMessage(this.snapshot(turnId), turnId)
  }

  close(): void {
    this.closeOpenThinking()
  }

  private markFirstEvent(): void {
    if (this.firstEventSeen) return
    this.firstEventSeen = true
    this.options.onFirstEvent?.()
  }

  private thinkingDuration(): number | undefined {
    if (
      !this.options.trackThinkingDuration ||
      this.thinkingStartedAt === null
    ) {
      this.thinkingStartedAt = null
      return undefined
    }
    const duration = (Date.now() - this.thinkingStartedAt) / 1000
    this.thinkingStartedAt = null
    return duration
  }

  private closeOpenThinking(): void {
    if (!this.timeline.isThinkingOpen) return
    this.timeline.endThinking(this.thinkingDuration())
    this.options.onThinkingChange?.(false)
  }

  private flushBufferedTail(): void {
    for (const event of this.normalizer.flush()) this.applyEvent(event)
    const { text } = this.preprocessor.flush()
    if (text) this.applyEvent({ type: 'content_delta', content: text })
  }

  private findWebSearchBlock(id?: string, query?: string) {
    if (id) {
      const blockId = this.webSearchBlocks.get(id)
      if (blockId) {
        return {
          blockId,
          current: this.timeline.getWebSearchState(blockId),
        }
      }
    }
    const searching = this.timeline.findSearchingWebSearch(query)
    if (id && searching) this.webSearchBlocks.set(id, searching.id)
    return { blockId: searching?.id, current: searching?.state }
  }

  private applyWebSearch(
    event: Extract<NormalizedEvent, { type: 'web_search' }>,
  ): void {
    const { id, status, query, sources, reason } = event
    if (status === 'in_progress' && query) {
      const blockId = this.timeline.pushWebSearch({
        query,
        status: 'searching',
      })
      if (id) this.webSearchBlocks.set(id, blockId)
    } else if (status === 'completed') {
      const { blockId, current } = this.findWebSearchBlock(id, query)
      const completed = {
        query: current?.query ?? query,
        status: 'completed' as const,
        sources: sources
          ? sources.map((source) => ({
              title: source.title || source.url,
              url: source.url,
            }))
          : current?.sources,
      }
      if (current) {
        this.timeline.updateWebSearch(completed, blockId)
      } else {
        this.timeline.pushWebSearch({
          ...completed,
          query,
          sources: completed.sources ?? [],
        })
      }
    } else if (status === 'failed') {
      const { blockId, current } = this.findWebSearchBlock(id, query)
      const failed = {
        query: current?.query ?? query,
        status: 'failed' as const,
        sources: [],
      }
      if (current) this.timeline.updateWebSearch(failed, blockId)
      else this.timeline.pushWebSearch({ ...failed, query })
    } else if (status === 'blocked') {
      const { blockId, current } = this.findWebSearchBlock(id, query)
      const blocked = {
        query: current?.query ?? query,
        status: 'blocked' as const,
        reason,
      }
      if (current) this.timeline.updateWebSearch(blocked, blockId)
      else this.timeline.pushWebSearch(blocked)
    }
  }

  private applyURLFetch(
    event: Extract<NormalizedEvent, { type: 'url_fetch' }>,
  ): void {
    if (event.status === 'in_progress') {
      this.timeline.addURLFetch({
        id: event.id,
        url: event.url,
        status: 'fetching',
      })
      return
    }
    const status: URLFetchState['status'] =
      event.status === 'blocked' ? 'failed' : event.status
    this.timeline.updateURLFetch(event.id, status)
  }

  private applyCodeExec(
    event: Extract<NormalizedEvent, { type: 'code_exec_tool_call' }>,
  ): void {
    if (event.status === 'in_progress') {
      this.timeline.pushCodeExecCall({
        id: event.id,
        toolName: event.toolName,
        arguments: event.arguments,
        status: 'running',
      })
      return
    }
    this.timeline.updateCodeExecCall(event.id, {
      status: event.status === 'blocked' ? 'failed' : event.status,
      output: event.output,
    })
  }

  private applyEvent(event: NormalizedEvent): void {
    this.changed = true
    switch (event.type) {
      case 'thinking_start':
        this.timeline.startThinking()
        this.thinkingStartedAt = this.options.trackThinkingDuration
          ? Date.now()
          : null
        this.options.onThinkingChange?.(true)
        this.markFirstEvent()
        break
      case 'thinking_delta':
        this.timeline.appendThinking(event.content)
        break
      case 'thinking_tail_delta':
        this.timeline.appendThinkingTail(event.content)
        break
      case 'thinking_end':
        this.timeline.endThinking(this.thinkingDuration())
        this.options.onThinkingChange?.(false)
        break
      case 'content_delta':
        this.timeline.appendContent(event.content)
        this.markFirstEvent()
        break
      case 'web_search':
        this.applyWebSearch(event)
        this.markFirstEvent()
        break
      case 'url_fetch':
        this.applyURLFetch(event)
        this.markFirstEvent()
        break
      case 'code_exec_tool_call':
        this.applyCodeExec(event)
        this.markFirstEvent()
        break
      case 'annotation': {
        this.assembler.addAnnotation(event.url, event.title)
        const current = this.timeline.getLastWebSearchState()
        if (current) {
          this.timeline.updateWebSearch({
            ...current,
            sources: [...this.assembler.collectedSources],
          })
        }
        break
      }
      case 'search_reasoning':
        this.assembler.addSearchReasoning(event.content)
        break
      case 'genui_tool_call_start':
        this.timeline.startToolCall(event.id, event.name)
        this.markFirstEvent()
        break
      case 'genui_tool_call_delta':
        this.timeline.appendToolCallArguments(event.id, event.argumentsDelta)
        break
    }
  }
}
