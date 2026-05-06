/**
 * Main streaming orchestrator.
 *
 * A thin `for await` loop that composes the pipeline:
 *   SSE reader → content preprocessor → event normalizer → switch dispatch
 *
 * Each event updates the TimelineBuilder (canonical state). The
 * MessageAssembler only tracks citation annotations and search reasoning;
 * all other flat Message fields are derived from the timeline in toMessage().
 * UI is flushed once per reader.read() chunk — no rAF needed.
 */

import { IS_DEV } from '@/config'
import { streamingTracker } from '@/services/cloud/streaming-tracker'
import {
  createStreamLogger,
  type StreamLogger,
} from '@/utils/dev-stream-logger'
import type { Message, URLFetchState } from '../../types'
import { createContentPreprocessor } from './content-preprocessor'
import { createEventNormalizer } from './event-normalizer'
import { MessageAssembler } from './message-assembler'
import { readSSEStream } from './sse-reader'
import { TimelineBuilder } from './timeline-builder'
import type { NormalizedEvent, StreamingContext } from './types'

export function getThinkingDuration(
  thinkingStartTimeRef: React.MutableRefObject<number | null>,
): number | undefined {
  const duration = thinkingStartTimeRef.current
    ? (Date.now() - thinkingStartTimeRef.current) / 1000
    : undefined
  thinkingStartTimeRef.current = null
  return duration
}

export async function processStreamingResponse(
  response: Response,
  ctx: StreamingContext,
): Promise<Message | null> {
  // Only create the stream logger in dev mode — in production this is undefined
  // and all logger?.foo() calls throughout the pipeline become no-ops.
  const streamLogger: StreamLogger | undefined = IS_DEV
    ? createStreamLogger()
    : undefined
  const startingChatId = ctx.startingChatId
  const streamingChatId = ctx.updatedChat.id
  const isSameChat = () => ctx.currentChatIdRef.current === startingChatId

  const preprocessor = createContentPreprocessor()
  const normalizer = createEventNormalizer()
  const timeline = new TimelineBuilder()
  const assembler = new MessageAssembler()

  let dirty = false
  let firstEventSeen = false

  const flushToUI = () => {
    if (!isSameChat()) return
    dirty = false
    const message = assembler.toMessage(timeline.snapshot())
    const newMessages = [...ctx.updatedMessages, message]
    ctx.updateChatWithHistoryCheck(
      ctx.setChats,
      { ...ctx.updatedChat, id: ctx.currentChatIdRef.current },
      ctx.setCurrentChat,
      ctx.currentChatIdRef.current,
      newMessages,
      false,
      true, // skip IndexedDB during streaming
    )
  }

  const markFirstEvent = () => {
    if (!firstEventSeen) {
      firstEventSeen = true
      ctx.setIsWaitingForResponse(false)
    }
  }

  const applyEvent = (event: NormalizedEvent): void => {
    switch (event.type) {
      case 'thinking_start':
        timeline.startThinking()
        markFirstEvent()
        ctx.setIsThinking(true)
        ctx.thinkingStartTimeRef.current = Date.now()
        break

      case 'thinking_delta':
        timeline.appendThinking(event.content)
        break

      case 'thinking_end': {
        const duration = getThinkingDuration(ctx.thinkingStartTimeRef)
        timeline.endThinking(duration)
        ctx.setIsThinking(false)
        break
      }

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

      case 'annotation': {
        assembler.addAnnotation(event.url, event.title)
        // Update timeline web search sources with accumulated citations
        const ws = timeline.getLastWebSearchState()
        if (ws) {
          timeline.updateWebSearch({
            ...ws,
            sources: [...assembler.collectedSources],
          })
        }
        break
      }

      case 'search_reasoning':
        assembler.addSearchReasoning(event.content)
        break

      case 'tool_call_start':
        timeline.startToolCall(event.id, event.name)
        markFirstEvent()
        break

      case 'tool_call_delta':
        timeline.appendToolCallArguments(event.id, event.argumentsDelta)
        break
    }

    dirty = true
  }

  const applyWebSearch = (
    event: Extract<NormalizedEvent, { type: 'web_search' }>,
  ): void => {
    const { status, query, sources, reason } = event

    if (status === 'in_progress' && query) {
      timeline.pushWebSearch({ query, status: 'searching' })
    } else if (status === 'completed') {
      const ws = timeline.getLastWebSearchState()
      const resolvedSources = sources
        ? sources.map((s) => ({ title: s.title || s.url, url: s.url }))
        : ws?.sources
      timeline.updateWebSearch({
        query: ws?.query,
        status: 'completed',
        sources: resolvedSources,
      })
    } else if (status === 'failed') {
      const ws = timeline.getLastWebSearchState()
      timeline.updateWebSearch({
        query: ws?.query,
        status: 'failed',
        sources: [],
      })
    } else if (status === 'blocked') {
      timeline.pushWebSearch({ query, status: 'blocked', reason })
    }
  }

  const applyURLFetch = (
    event: Extract<NormalizedEvent, { type: 'url_fetch' }>,
  ): void => {
    if (event.status === 'in_progress') {
      timeline.addURLFetch({
        id: event.id,
        url: event.url,
        status: 'fetching',
      })
    } else {
      const mapped: URLFetchState['status'] =
        event.status === 'blocked' ? 'failed' : event.status
      timeline.updateURLFetch(event.id, mapped)
    }
  }

  try {
    ctx.isStreamingRef.current = true
    if (streamingChatId) streamingTracker.startStreaming(streamingChatId)

    for await (const sseJson of readSSEStream(response, streamLogger)) {
      if (!isSameChat()) break

      const events = normalizer.processChunk(
        sseJson,
        preprocessor,
        streamLogger,
      )
      for (const event of events) {
        applyEvent(event)
      }

      if (dirty) flushToUI()
    }

    // Flush normalizer tail (buffered first-chunk or unclosed thinking)
    for (const event of normalizer.flush()) {
      applyEvent(event)
    }

    // Flush preprocessor tail (partial tinfoil/channel tags)
    const { text: tail } = preprocessor.flush()
    if (tail) {
      applyEvent({ type: 'content_delta', content: tail })
    }

    // Finalize any open thinking block
    if (timeline.isThinkingOpen) {
      const duration = getThinkingDuration(ctx.thinkingStartTimeRef)
      timeline.endThinking(duration)
      dirty = true
    }

    // Final flush
    if (dirty) flushToUI()

    streamLogger?.flush(streamingChatId)
    return assembler.toMessage(timeline.snapshot())
  } finally {
    ctx.setLoadingState('idle')
    ctx.isStreamingRef.current = false
    ctx.setIsStreaming(false)
    if (streamingChatId) streamingTracker.endStreaming(streamingChatId)
    if (
      ctx.currentChatIdRef.current &&
      ctx.currentChatIdRef.current !== streamingChatId
    ) {
      streamingTracker.endStreaming(ctx.currentChatIdRef.current)
    }
    ctx.setIsThinking(false)
    ctx.thinkingStartTimeRef.current = null
    ctx.setIsWaitingForResponse(false)
  }
}
