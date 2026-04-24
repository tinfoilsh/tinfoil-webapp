/**
 * Renders a set of GenUI tool calls inline in the chat.
 *
 * While a tool call is still streaming (its arguments JSON is incomplete),
 * a placeholder is shown. Once arguments parse and a minimum placeholder
 * hold elapses, the corresponding widget is rendered. Unknown or malformed
 * tool calls render a muted fallback card after streaming ends.
 *
 * Input-surface widgets are skipped here — they render inside `ChatInput`
 * via `GenUIInputAreaRenderer`.
 */
import { LoadingDots } from '@/components/loading-dots'
import { logError } from '@/utils/error-handling'
import { RefreshCw } from 'lucide-react'
import React, { memo, useEffect, useRef, useState } from 'react'
import { getGenUIWidget, renderGenUIInline } from './render'
import type { GenUIToolCall } from './types'

interface GenUIToolCallRendererProps {
  toolCalls: GenUIToolCall[]
  isStreaming: boolean
  isDarkMode?: boolean
  /**
   * If provided, a "Try again" button is shown on parse-failure cards and
   * will regenerate the assistant message that produced the failed tool
   * call. Intended to be bound to the chat-level regenerate handler.
   */
  onRetry?: () => void
}

/** Minimum time (ms) a placeholder stays visible after we could render. */
const PLACEHOLDER_MIN_DURATION_MS = 300

function resolveInput(tc: GenUIToolCall): Record<string, unknown> | null {
  if (!tc.arguments) return null
  try {
    const parsed = JSON.parse(tc.arguments)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Arguments still streaming, JSON incomplete
  }
  return null
}

function usePlaceholderRelease(
  toolCalls: GenUIToolCall[],
  minDurationMs: number,
): Set<string> {
  const firstSeenAtRef = useRef<Map<string, number>>(new Map())
  const [releasedIds, setReleasedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const now = Date.now()
    const firstSeen = firstSeenAtRef.current
    const timers: ReturnType<typeof setTimeout>[] = []

    for (const tc of toolCalls) {
      if (!firstSeen.has(tc.id)) {
        firstSeen.set(tc.id, now)
      }
      if (releasedIds.has(tc.id)) continue

      const shownAt = firstSeen.get(tc.id) ?? now
      const elapsed = now - shownAt
      const remaining = Math.max(0, minDurationMs - elapsed)
      const id = tc.id

      const timer = setTimeout(() => {
        setReleasedIds((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }, remaining)
      timers.push(timer)
    }

    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [toolCalls, minDurationMs, releasedIds])

  return releasedIds
}

export const GenUIToolCallRenderer = memo(function GenUIToolCallRenderer({
  toolCalls,
  isStreaming,
  isDarkMode,
  onRetry,
}: GenUIToolCallRendererProps) {
  const releasedIds = usePlaceholderRelease(
    toolCalls,
    PLACEHOLDER_MIN_DURATION_MS,
  )

  return (
    <React.Fragment>
      {toolCalls.map((tc) => {
        const widget = getGenUIWidget(tc.name)

        // Input-surface widgets render inside ChatInput, not in the chat
        // scroll — skip them here. They're handled by the renderer that
        // shows resolved stamps when applicable.
        if (widget && widget.surface === 'input') {
          return null
        }

        const input = resolveInput(tc)
        const canShowComponent = !isStreaming || releasedIds.has(tc.id)

        if (input && canShowComponent) {
          const rendered = renderGenUIInline(tc.name, input, { isDarkMode })
          if (rendered) {
            return (
              <div key={tc.id} className="my-4">
                {rendered}
              </div>
            )
          }
        }

        if (isStreaming) {
          return (
            <div
              key={tc.id}
              className="my-4 flex items-center gap-2 rounded-lg border border-border-subtle bg-transparent px-4 py-3"
            >
              <span
                className="h-2 w-2 animate-pulse rounded-full bg-content-primary"
                aria-hidden
              />
              <span className="text-sm font-medium text-content-primary">
                Generating component
              </span>
              <LoadingDots />
            </div>
          )
        }

        // Not streaming, and either:
        //  - JSON never completed (`input` is null), or
        //  - schema validation failed (`renderGenUIInline` returned null).
        // In both cases the model did not produce a valid widget. Surface
        // an error card with a retry affordance when available.
        logError(
          'GenUI parse/render failed',
          new Error(`Unable to produce a valid widget: ${tc.name}`),
          {
            component: 'GenUIToolCallRenderer',
            action: 'render',
            metadata: { toolName: tc.name, hasInput: !!input },
          },
        )
        return (
          <div
            key={tc.id}
            className="my-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-card px-4 py-3 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium text-content-primary">
                Couldn&apos;t produce a valid widget
              </span>
              <span className="text-xs text-content-muted">
                The model returned a response that didn&apos;t match the{' '}
                {tc.name} widget schema.
              </span>
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm font-medium text-content-primary transition-colors hover:bg-surface-card"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </button>
            )}
          </div>
        )
      })}
    </React.Fragment>
  )
})
