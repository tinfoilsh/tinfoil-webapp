import type { Message, URLFetchState } from '../../types'
import { createContentPreprocessor } from './content-preprocessor'
import { createEventNormalizer } from './event-normalizer'
import { MessageAssembler } from './message-assembler'
import { readSSEStream } from './sse-reader'
import { TimelineBuilder } from './timeline-builder'
import type { NormalizedEvent } from './types'

export interface RichResponseParserOptions {
  trackThinkingDuration?: boolean
  onUpdate?: (message: Message) => void
  onFirstEvent?: () => void
  onThinkingChange?: (isThinking: boolean) => void
}

export async function parseRichStreamingResponse(
  response: Response,
  options: RichResponseParserOptions = {},
): Promise<Message> {
  const preprocessor = createContentPreprocessor()
  const normalizer = createEventNormalizer()
  const timeline = new TimelineBuilder()
  const assembler = new MessageAssembler()
  const webSearchBlocks = new Map<string, string>()
  let firstEventSeen = false
  let thinkingStartedAt: number | null = null

  const markFirstEvent = () => {
    if (firstEventSeen) return
    firstEventSeen = true
    options.onFirstEvent?.()
  }

  const thinkingDuration = (): number | undefined => {
    if (!options.trackThinkingDuration || thinkingStartedAt === null) {
      thinkingStartedAt = null
      return undefined
    }
    const duration = (Date.now() - thinkingStartedAt) / 1000
    thinkingStartedAt = null
    return duration
  }

  const findWebSearchBlock = (id?: string, query?: string) => {
    if (id) {
      const blockId = webSearchBlocks.get(id)
      if (blockId) {
        return {
          blockId,
          current: timeline.getWebSearchState(blockId),
        }
      }
    }
    const searching = timeline.findSearchingWebSearch(query)
    if (id && searching) webSearchBlocks.set(id, searching.id)
    return { blockId: searching?.id, current: searching?.state }
  }

  const applyWebSearch = (
    event: Extract<NormalizedEvent, { type: 'web_search' }>,
  ) => {
    const { id, status, query, sources, reason } = event
    if (status === 'in_progress' && query) {
      const blockId = timeline.pushWebSearch({ query, status: 'searching' })
      if (id) webSearchBlocks.set(id, blockId)
    } else if (status === 'completed') {
      const { blockId, current } = findWebSearchBlock(id, query)
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
        timeline.updateWebSearch(completed, blockId)
      } else {
        timeline.pushWebSearch({
          ...completed,
          query,
          sources: completed.sources ?? [],
        })
      }
    } else if (status === 'failed') {
      const { blockId, current } = findWebSearchBlock(id, query)
      const failed = {
        query: current?.query ?? query,
        status: 'failed' as const,
        sources: [],
      }
      if (current) {
        timeline.updateWebSearch(failed, blockId)
      } else {
        timeline.pushWebSearch({ ...failed, query })
      }
    } else if (status === 'blocked') {
      const { blockId, current } = findWebSearchBlock(id, query)
      const blocked = {
        query: current?.query ?? query,
        status: 'blocked' as const,
        reason,
      }
      if (current) {
        timeline.updateWebSearch(blocked, blockId)
      } else {
        timeline.pushWebSearch(blocked)
      }
    }
  }

  const applyURLFetch = (
    event: Extract<NormalizedEvent, { type: 'url_fetch' }>,
  ) => {
    if (event.status === 'in_progress') {
      timeline.addURLFetch({
        id: event.id,
        url: event.url,
        status: 'fetching',
      })
      return
    }
    const status: URLFetchState['status'] =
      event.status === 'blocked' ? 'failed' : event.status
    timeline.updateURLFetch(event.id, status)
  }

  const applyCodeExec = (
    event: Extract<NormalizedEvent, { type: 'code_exec_tool_call' }>,
  ) => {
    if (event.status === 'in_progress') {
      timeline.pushCodeExecCall({
        id: event.id,
        toolName: event.toolName,
        arguments: event.arguments,
        status: 'running',
      })
      return
    }
    timeline.updateCodeExecCall(event.id, {
      status: event.status === 'blocked' ? 'failed' : event.status,
      output: event.output,
    })
  }

  const applyEvent = (event: NormalizedEvent) => {
    switch (event.type) {
      case 'thinking_start':
        timeline.startThinking()
        thinkingStartedAt = options.trackThinkingDuration ? Date.now() : null
        options.onThinkingChange?.(true)
        markFirstEvent()
        break
      case 'thinking_delta':
        timeline.appendThinking(event.content)
        break
      case 'thinking_tail_delta':
        timeline.appendThinkingTail(event.content)
        break
      case 'thinking_end':
        timeline.endThinking(thinkingDuration())
        options.onThinkingChange?.(false)
        break
      case 'content_delta':
        timeline.appendContent(event.content)
        markFirstEvent()
        break
      case 'web_search':
        applyWebSearch(event)
        markFirstEvent()
        break
      case 'url_fetch':
        applyURLFetch(event)
        break
      case 'code_exec_tool_call':
        applyCodeExec(event)
        markFirstEvent()
        break
      case 'annotation': {
        assembler.addAnnotation(event.url, event.title)
        const current = timeline.getLastWebSearchState()
        if (current) {
          timeline.updateWebSearch({
            ...current,
            sources: [...assembler.collectedSources],
          })
        }
        break
      }
      case 'search_reasoning':
        assembler.addSearchReasoning(event.content)
        break
      case 'genui_tool_call_start':
        timeline.startToolCall(event.id, event.name)
        markFirstEvent()
        break
      case 'genui_tool_call_delta':
        timeline.appendToolCallArguments(event.id, event.argumentsDelta)
        break
    }
  }

  try {
    for await (const json of readSSEStream(response)) {
      for (const event of normalizer.processChunk(json, preprocessor)) {
        applyEvent(event)
      }
      options.onUpdate?.(assembler.toMessage(timeline.snapshot()))
    }

    for (const event of normalizer.flush()) {
      applyEvent(event)
    }
    const { text: tail } = preprocessor.flush()
    if (tail) {
      applyEvent({ type: 'content_delta', content: tail })
    }
  } finally {
    if (timeline.isThinkingOpen) {
      timeline.endThinking(thinkingDuration())
      options.onThinkingChange?.(false)
    }
  }

  const message = assembler.toMessage(timeline.snapshot())
  options.onUpdate?.(message)
  return message
}
