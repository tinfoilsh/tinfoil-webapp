/**
 * Event normalizer.
 *
 * Consumes raw SSE JSON objects (after content preprocessing) and emits
 * a flat list of NormalizedEvent[]. Encapsulates all three thinking format
 * detection strategies and the first-chunk buffering heuristic.
 *
 * After this module, the downstream processor only sees `thinking_start`,
 * `thinking_delta`, `thinking_end`, `content_delta`, etc. — no format
 * sniffing needed.
 */

import type { StreamLogger } from '@/utils/dev-stream-logger'
import type { TinfoilWebSearchCallEvent } from '@/utils/tinfoil-events'
import type { ContentPreprocessor } from './content-preprocessor'
import type { NormalizedEvent } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Untyped SSE JSON from the stream. We access `choices[0].delta.*`
 * extensively; a proper OpenAI type would be overkill here since
 * we handle missing fields with optional chaining throughout.
 */

type SSEJson = any

function extractReasoningContent(json: SSEJson): string | null {
  const delta =
    json.choices?.[0]?.delta?.reasoning_content ??
    json.choices?.[0]?.delta?.reasoning
  const message =
    json.choices?.[0]?.message?.reasoning_content ??
    json.choices?.[0]?.message?.reasoning
  const hasDelta = delta !== undefined && delta !== null
  const hasMessage = message !== undefined && message !== null
  if (!hasDelta && !hasMessage) return null
  return (
    json.choices?.[0]?.message?.reasoning_content ||
    json.choices?.[0]?.message?.reasoning ||
    json.choices?.[0]?.delta?.reasoning_content ||
    json.choices?.[0]?.delta?.reasoning ||
    ''
  )
}

function extractAnnotations(json: SSEJson): NormalizedEvent[] {
  const annotations = json.choices?.[0]?.delta?.annotations
  if (!annotations || !Array.isArray(annotations)) return []
  const events: NormalizedEvent[] = []
  for (const a of annotations) {
    if (a.type === 'url_citation' && a.url_citation?.url) {
      events.push({
        type: 'annotation',
        url: a.url_citation.url,
        title: a.url_citation.title || a.url_citation.url,
      })
    }
  }
  return events
}

type WebSearchStatus = Extract<
  NormalizedEvent,
  { type: 'web_search' }
>['status']
type URLFetchStatus = Extract<NormalizedEvent, { type: 'url_fetch' }>['status']

/** Map tinfoil event status → our canonical status (drops 'searching'). */
function toWebSearchStatus(s: string): WebSearchStatus {
  if (s === 'searching') return 'in_progress'
  return s as WebSearchStatus
}

function toURLFetchStatus(s: string): URLFetchStatus {
  if (s === 'searching') return 'in_progress'
  return s as URLFetchStatus
}

function normalizeToolEvent(
  event: TinfoilWebSearchCallEvent,
  logger?: StreamLogger,
): NormalizedEvent[] {
  logger?.logTinfoilEvent(event)

  const action = event.action
  if (action?.type === 'open_page' && action.url) {
    const mapped: NormalizedEvent = {
      type: 'url_fetch',
      id: event.item_id || action.url,
      url: action.url,
      status: toURLFetchStatus(event.status),
    }
    logger?.logWebSearchDispatch(mapped)
    return [mapped]
  }

  const mapped: NormalizedEvent = {
    type: 'web_search',
    id: event.item_id,
    status: toWebSearchStatus(event.status),
    query: action?.query,
    sources: event.sources,
    reason: event.error?.code,
  }
  logger?.logWebSearchDispatch(mapped)
  return [mapped]
}

function normalizeLegacyToolEvent(json: SSEJson): NormalizedEvent[] {
  return [
    {
      type: 'web_search',
      id: typeof json.id === 'string' ? json.id : undefined,
      status: toWebSearchStatus(String(json.status ?? '')),
      query: json.action?.query,
      reason: typeof json.reason === 'string' ? json.reason : undefined,
    },
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EventNormalizer {
  processChunk(
    sseJson: SSEJson,
    preprocessor: ContentPreprocessor,
    logger?: StreamLogger,
  ): NormalizedEvent[]
  flush(): NormalizedEvent[]
}

/**
 * Extracts tool-call events from an OpenAI streaming chunk. The model may
 * emit multiple concurrent tool calls identified by `index`; `id` and
 * `function.name` only appear on the first chunk per tool call, while
 * subsequent chunks only carry `function.arguments` deltas.
 */
function extractToolCallEvents(
  json: SSEJson,
  indexToId: Map<number, string>,
  startedIds: Set<string>,
): NormalizedEvent[] {
  const toolCalls = json.choices?.[0]?.delta?.tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return []

  const events: NormalizedEvent[] = []
  for (const tc of toolCalls) {
    const index: number | undefined =
      typeof tc.index === 'number' ? tc.index : undefined
    if (index === undefined) continue

    let id: string | undefined = indexToId.get(index)
    if (!id && typeof tc.id === 'string' && tc.id.length > 0) {
      const newId: string = tc.id
      id = newId
      indexToId.set(index, newId)
    }
    if (!id) continue

    const name: string | undefined =
      typeof tc.function?.name === 'string' ? tc.function.name : undefined

    if (name && !startedIds.has(id)) {
      events.push({ type: 'tool_call_start', id, name })
      startedIds.add(id)
    }

    const argsDelta: string | undefined =
      typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : undefined
    if (argsDelta) {
      events.push({ type: 'tool_call_delta', id, argumentsDelta: argsDelta })
    }
  }
  return events
}

export function createEventNormalizer(): EventNormalizer {
  let isFirstChunk = true
  let initialBuffer = ''
  let isInThinking = false
  let isReasoningFormat = false
  const toolCallIndexToId = new Map<number, string>()
  const toolCallStartedIds = new Set<string>()
  // Once the assistant has started emitting a tool call, any subsequent
  // `delta.content` is almost always serialization noise from the provider
  // (fragments of the tool name or trailing whitespace) rather than real
  // prose. Suppress all content emitted after the first tool call starts.
  let sawToolCall = false

  return {
    processChunk(sseJson, preprocessor, logger): NormalizedEvent[] {
      const events: NormalizedEvent[] = []

      // Legacy top-level web_search_call records
      if (sseJson.type === 'web_search_call') {
        if (isInThinking) {
          events.push({ type: 'thinking_end' })
          isInThinking = false
        }
        events.push(...normalizeLegacyToolEvent(sseJson))
        return events
      }

      // GenUI tool calls (OpenAI streaming shape). Close any open thinking
      // block first so tool calls appear after it chronologically, same
      // pattern as web_search / url_fetch.
      const toolCallEvents = extractToolCallEvents(
        sseJson,
        toolCallIndexToId,
        toolCallStartedIds,
      )
      if (toolCallEvents.length > 0) {
        if (isInThinking) {
          events.push({ type: 'thinking_end' })
          isInThinking = false
        }
        events.push(...toolCallEvents)
        sawToolCall = true
      }

      // Search reasoning
      const searchReasoning = sseJson.choices?.[0]?.delta?.search_reasoning
      if (searchReasoning) {
        events.push({ type: 'search_reasoning', content: searchReasoning })
      }

      // Annotations
      events.push(...extractAnnotations(sseJson))

      // Preprocess content (strip tinfoil markers, normalize channel tags).
      // Once a tool call has been emitted on this assistant turn, drop any
      // further `delta.content` — providers sometimes trail serialization
      // noise (fragments of the tool name) through the content channel.
      const rawContent: string = sawToolCall
        ? ''
        : sseJson.choices?.[0]?.delta?.content || ''
      const preprocessed = preprocessor.process(rawContent)

      // Tool events from tinfoil markers — close thinking first so
      // downstream gets proper thinking_end → tool → thinking_start
      // boundaries when reasoning resumes.
      if (preprocessed.toolEvents.length > 0) {
        if (isInThinking) {
          events.push({ type: 'thinking_end' })
          isInThinking = false
        }
        for (const toolEvent of preprocessed.toolEvents) {
          events.push(...normalizeToolEvent(toolEvent, logger))
        }
      }

      let content = preprocessed.text
      const reasoningContent = extractReasoningContent(sseJson)

      // -----------------------------------------------------------------
      // reasoning_content format (OpenAI-style)
      // -----------------------------------------------------------------

      if (reasoningContent !== null && !isReasoningFormat && !isInThinking) {
        // First reasoning chunk — enter reasoning format
        isReasoningFormat = true
        isInThinking = true
        isFirstChunk = false
        events.push({ type: 'thinking_start' })
        if (reasoningContent) {
          events.push({ type: 'thinking_delta', content: reasoningContent })
        }
        return events
      }

      if (isReasoningFormat && reasoningContent !== null) {
        // Continued reasoning chunks
        if (reasoningContent) {
          // If we were out of thinking (content interrupted), restart
          if (!isInThinking) {
            isInThinking = true
            events.push({ type: 'thinking_start' })
          }
          events.push({ type: 'thinking_delta', content: reasoningContent })
        }
        if (content && isInThinking) {
          events.push({ type: 'thinking_end' })
          isInThinking = false
          events.push({ type: 'content_delta', content })
        }
        return events
      }

      if (isReasoningFormat && content) {
        // Content-only chunk after reasoning format was established
        if (isInThinking) {
          events.push({ type: 'thinking_end' })
          isInThinking = false
        }
        events.push({ type: 'content_delta', content })
        return events
      }

      // If reasoning format is active but no content/reasoning, return
      // whatever metadata events we collected (annotations etc.)
      if (isReasoningFormat) {
        return events
      }

      // -----------------------------------------------------------------
      // <think> tag format (DeepSeek-style)
      // -----------------------------------------------------------------

      if (isFirstChunk) {
        initialBuffer += content
        if (initialBuffer.includes('<think>') || initialBuffer.length > 5) {
          isFirstChunk = false
          content = initialBuffer
          initialBuffer = ''

          if (content.includes('<think>')) {
            isInThinking = true
            content = content.replace(/^[\s\S]*?<think>/, '')
            events.push({ type: 'thinking_start' })

            // Handle same-chunk </think>
            const closeIdx = content.indexOf('</think>')
            if (closeIdx !== -1) {
              const inner = content.slice(0, closeIdx)
              const remaining = content.slice(closeIdx + 8)
              if (inner) {
                events.push({ type: 'thinking_delta', content: inner })
              }
              events.push({ type: 'thinking_end' })
              isInThinking = false
              if (remaining.trim()) {
                events.push({ type: 'content_delta', content: remaining })
              }
              return events
            }

            if (content) {
              events.push({ type: 'thinking_delta', content })
            }
            return events
          }
          // No <think> tag — fall through to content handling below
        } else {
          // Still buffering first chunk
          return events
        }
      }

      // Mid-stream </think> close
      if (content.includes('</think>') && isInThinking) {
        const parts = content.split('</think>')
        const finalThinking = parts[0] || ''
        const remaining = parts.slice(1).join('')

        if (finalThinking) {
          events.push({ type: 'thinking_delta', content: finalThinking })
        }
        events.push({ type: 'thinking_end' })
        isInThinking = false

        if (remaining.trim()) {
          events.push({ type: 'content_delta', content: remaining })
        }
        return events
      }

      // Inside thinking — buffer delta
      if (isInThinking) {
        if (content) {
          events.push({ type: 'thinking_delta', content })
        }
        return events
      }

      // -----------------------------------------------------------------
      // Plain content
      // -----------------------------------------------------------------

      // Strip stray think tags that might appear in non-thinking content
      content = content.replace(/<think>|<\/think>/g, '')
      if (content) {
        events.push({ type: 'content_delta', content })
      }

      return events
    },

    flush(): NormalizedEvent[] {
      const events: NormalizedEvent[] = []
      if (isFirstChunk && initialBuffer.trim()) {
        events.push({ type: 'content_delta', content: initialBuffer.trim() })
        initialBuffer = ''
      }
      if (isInThinking) {
        events.push({ type: 'thinking_end' })
        isInThinking = false
      }
      return events
    },
  }
}
