/**
 * Renders a set of GenUI tool calls inline in the chat.
 *
 * While the assistant message is still streaming, a tracer placeholder is
 * always shown — even if the tool arguments JSON has fully parsed — so the
 * user has continuous visual feedback until the turn completes. Once
 * streaming ends, the placeholder is swapped for the real widget (or a
 * parse-failure card if arguments are invalid).
 *
 * Input-surface widgets are skipped here — they render inside `ChatInput`
 * via `GenUIInputAreaRenderer`.
 */
import { logError } from '@/utils/error-handling'
import { ChevronRight, RefreshCw, Sparkles } from 'lucide-react'
import React, { memo, useEffect, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { tryParsePartialJson } from './partial-json'
import { getGenUIWidget, renderGenUIInline } from './render'
import type { GenUIToolCall } from './types'

/**
 * Convert a `render_artifact_preview` tool name into a human-friendly
 * label for the streaming tracer ("artifact preview"). We strip the
 * `render_` prefix (every GenUI widget uses it) and replace underscores
 * with spaces.
 */
function prettyWidgetName(toolName: string): string {
  return toolName.replace(/^render_/, '').replace(/_/g, ' ')
}

/**
 * Pull a short human-readable hint out of partially-streamed tool
 * arguments. We try the small set of fields most widgets surface as
 * their primary label so the tracer can show "Generating chart: Sales
 * by region" rather than a generic spinner. Returns null when nothing
 * useful has streamed yet.
 */
function extractPartialHint(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  const candidates = ['title', 'question', 'description', 'label', 'name']
  for (const key of candidates) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

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

export const GenUIToolCallRenderer = memo(function GenUIToolCallRenderer({
  toolCalls,
  isStreaming,
  isDarkMode,
  onRetry,
}: GenUIToolCallRendererProps) {
  return (
    <React.Fragment>
      {toolCalls.map((tc) => {
        // Computer-use tool calls (e.g. computer_begin) are handled by the
        // computer-use session dialog, not the GenUI widget system — don't
        // render an "unavailable widget" card for them.
        if (tc.name.startsWith('computer_')) {
          return null
        }

        const widget = getGenUIWidget(tc.name)

        // Input-surface widgets render inside ChatInput, not in the chat
        // scroll — skip them here. They're handled by the renderer that
        // shows resolved stamps when applicable.
        if (widget && widget.surface === 'input') {
          return null
        }

        // While the assistant is still streaming, always show the tracer.
        // This guarantees continuous visual feedback from the moment the
        // tool call starts until the turn completes, even if the JSON
        // arguments finish parsing early.
        if (isStreaming) {
          return <StreamingToolCallTracer key={tc.id} toolCall={tc} />
        }

        const input = resolveInput(tc)
        if (input) {
          const rendered = renderGenUIInline(tc.name, input, { isDarkMode })
          if (rendered) {
            return (
              <div key={tc.id} className="my-4">
                {rendered}
              </div>
            )
          }
        }

        // The widget itself isn't registered on this client (e.g. a tool
        // call recorded before the widget was added or after it was
        // removed). Surface a soft, non-blocking notice — there's nothing
        // to retry because the schema is unknown here.
        if (!widget) {
          return (
            <div
              key={tc.id}
              className="my-4 flex items-start gap-2.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 text-sm"
            >
              <Sparkles
                className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-500"
                aria-hidden
              />
              <div className="flex flex-col">
                <span className="font-medium text-content-primary">
                  Component unavailable
                </span>
                <span className="text-xs text-content-muted">
                  This message includes a component that isn&apos;t available in
                  this version of the app.
                </span>
              </div>
            </div>
          )
        }

        // Registered widget but schema validation failed. The model
        // produced something the widget couldn't accept — offer a retry.
        return (
          <ParseFailureCard
            key={tc.id}
            toolName={tc.name}
            hasInput={!!input}
            onRetry={onRetry}
          />
        )
      })}
    </React.Fragment>
  )
})

/**
 * Live tracer shown while the model is streaming a GenUI tool call.
 *
 * Replaces a static spinner with a card that surfaces:
 *   - The widget name being generated (e.g. "artifact preview").
 *   - A short hint pulled from the partially-streamed JSON when one is
 *     available (the tool's `title` / `description` etc.).
 *   - A live byte counter so the user can tell the stream is still
 *     making progress even when no human-readable hint has streamed.
 *   - A collapsible raw JSON view for power users who want to see
 *     exactly what the model is sending.
 */
function StreamingToolCallTracer({ toolCall }: { toolCall: GenUIToolCall }) {
  const [showRaw, setShowRaw] = useState(false)
  const partial = tryParsePartialJson(toolCall.arguments)
  const hint = extractPartialHint(partial)
  const charCount = toolCall.arguments.length
  const label = prettyWidgetName(toolCall.name)

  return (
    <div className="my-4 rounded-lg border border-border-subtle bg-transparent px-4 py-3">
      <div className="flex items-center gap-2">
        <PiSpinner
          className="h-3.5 w-3.5 animate-spin text-content-primary"
          aria-hidden
        />
        <span className="text-sm font-medium text-content-primary">
          Generating {label}
          {hint ? `: ${hint}` : null}
        </span>
        {charCount > 0 && (
          <span className="ml-auto text-xs tabular-nums text-content-muted">
            {charCount.toLocaleString()} chars
          </span>
        )}
      </div>
      {charCount > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowRaw((prev) => !prev)}
            className="flex items-center gap-1 text-xs text-content-muted hover:text-content-primary"
            aria-expanded={showRaw}
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showRaw ? 'rotate-90' : ''}`}
              aria-hidden
            />
            {showRaw ? 'Hide stream' : 'Show stream'}
          </button>
          {showRaw && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface-chat-background p-2 text-xs text-content-muted">
              <code>{toolCall.arguments}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ParseFailureCard({
  toolName,
  hasInput,
  onRetry,
}: {
  toolName: string
  hasInput: boolean
  onRetry?: () => void
}) {
  // Logging is a side effect — kept out of render so React's render-twice
  // strict mode and re-renders from parent state changes don't produce
  // duplicate log lines for the same failure.
  useEffect(() => {
    logError(
      'GenUI parse/render failed',
      new Error(`Unable to produce a valid widget: ${toolName}`),
      {
        component: 'GenUIToolCallRenderer',
        action: 'render',
        metadata: { toolName, hasInput },
      },
    )
  }, [toolName, hasInput])

  return (
    <div className="my-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-card px-4 py-3 text-sm">
      <div className="flex flex-col">
        <span className="font-medium text-content-primary">
          Couldn&apos;t display this widget
        </span>
        <span className="text-xs text-content-muted">
          The response didn&apos;t match the {toolName} widget&apos;s expected
          shape.
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
}
