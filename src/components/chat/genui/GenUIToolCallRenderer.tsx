/**
 * Renders a set of GenUI tool calls inline in the chat.
 *
 * While the assistant message is still streaming, a tracer placeholder is
 * shown until the tool arguments are complete enough to render. This lets the
 * widget appear as soon as its own stream is done, even if the assistant turn
 * continues into another stage like thinking.
 *
 * Input-surface widgets are skipped here — they render inside `ChatInput`
 * via `GenUIInputAreaRenderer`.
 */
import { logError } from '@/utils/error-handling'
import { TfRefresh1 } from '@tinfoilsh/tinfoil-icons'
import { Sparkles } from 'lucide-react'
import React, { memo, useEffect, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { tryParsePartialJson } from './partial-json'
import { getGenUIWidget, renderGenUIInline } from './render'
import { ArtifactRetryError, type ArtifactRetryErrorCode } from './retry'
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
  activeArtifactToolCallId?: string | null
  /**
   * If provided, a "Try again" button is shown on parse-failure cards and
   * will regenerate the assistant message that produced the failed tool
   * call. Intended to be bound to the chat-level regenerate handler.
   */
  onRetry?: () => void
  /**
   * Widget-only retry: re-request just this tool call's arguments and patch
   * the block in place, leaving the rest of the answer intact. Rejects with a
   * typed failure so the card can explain it and keep retry available.
   */
  onRetryToolCall?: (toolCallId: string) => Promise<boolean>
}

function parseInput(
  tc: GenUIToolCall,
): { ok: true; data: unknown } | { ok: false } {
  if (!tc.arguments) return { ok: false }
  try {
    return { ok: true, data: JSON.parse(tc.arguments) }
  } catch {
    return { ok: false }
  }
}

function GenUIWidgetContent({
  toolCallId,
  toolName,
  input,
  isActive,
  isDarkMode,
  isStreaming,
}: {
  toolCallId: string
  toolName: string
  input: unknown
  isActive: boolean
  isDarkMode?: boolean
  isStreaming: boolean
}) {
  const rendered = renderGenUIInline(toolName, input, {
    isActive,
    isDarkMode,
    isStreaming,
    toolCallId,
  })
  if (rendered === null) throw new Error('Widget render returned null')
  return rendered
}

export const GenUIToolCallRenderer = memo(function GenUIToolCallRenderer({
  toolCalls,
  isStreaming,
  isDarkMode,
  activeArtifactToolCallId,
  onRetry,
  onRetryToolCall,
}: GenUIToolCallRendererProps) {
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

        // The schema is unavailable on this client, so waiting for more
        // argument bytes cannot make this component renderable.
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

        const input = parseInput(tc)
        const parsedInput = input.ok
          ? widget.schema.safeParse(input.data)
          : null
        if (parsedInput?.success && widget.render) {
          return (
            <GenUIWidgetErrorBoundary
              key={tc.id}
              toolName={tc.name}
              argumentsValue={tc.arguments}
              onRetry={onRetry}
              onRetryToolCall={
                onRetryToolCall ? () => onRetryToolCall(tc.id) : undefined
              }
            >
              <div className="my-4">
                <GenUIWidgetContent
                  toolCallId={tc.id}
                  toolName={tc.name}
                  input={parsedInput.data}
                  isActive={activeArtifactToolCallId === tc.id}
                  isDarkMode={isDarkMode}
                  isStreaming={isStreaming}
                />
              </div>
            </GenUIWidgetErrorBoundary>
          )
        }

        if (isStreaming && !input.ok) {
          return <StreamingToolCallTracer key={tc.id} toolCall={tc} />
        }

        // Registered widget but schema validation failed. The model
        // produced something the widget couldn't accept — offer a retry.
        return (
          <ParseFailureCard
            key={tc.id}
            toolName={tc.name}
            failure={
              parsedInput && !parsedInput.success
                ? {
                    type: 'schema_invalid',
                    issues: parsedInput.error.issues.map((issue) => ({
                      code: issue.code,
                      path: issue.path,
                    })),
                  }
                : { type: 'invalid_json' }
            }
            onRetry={onRetry}
            onRetryToolCall={
              onRetryToolCall ? () => onRetryToolCall(tc.id) : undefined
            }
          />
        )
      })}
    </React.Fragment>
  )
})

interface GenUIWidgetErrorBoundaryProps {
  toolName: string
  argumentsValue: string
  onRetry?: () => void
  onRetryToolCall?: () => Promise<boolean>
  children: React.ReactNode
}

/**
 * Catches render-time throws inside a widget so a single bad widget shows
 * a compact notice instead of crashing the whole message tree.
 */
class GenUIWidgetErrorBoundary extends React.Component<
  GenUIWidgetErrorBoundaryProps,
  { hasError: boolean }
> {
  constructor(props: GenUIWidgetErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: Error): void {
    logError('GenUI widget crashed while rendering', error, {
      component: 'GenUIWidgetErrorBoundary',
      action: 'render',
      metadata: {
        toolName: this.props.toolName,
        failure: 'render_exception',
      },
    })
  }

  componentDidUpdate(previousProps: GenUIWidgetErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      previousProps.argumentsValue !== this.props.argumentsValue
    ) {
      this.setState({ hasError: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <ParseFailureCard
          toolName={this.props.toolName}
          failure={{ type: 'render_exception' }}
          onRetry={this.props.onRetry}
          onRetryToolCall={this.props.onRetryToolCall}
          onRepairSuccess={() => this.setState({ hasError: false })}
          logFailure={false}
        />
      )
    }
    return this.props.children
  }
}

/**
 * Live tracer shown while the model is streaming a GenUI tool call.
 *
 * Replaces a static spinner with the widget name and a title when one has
 * streamed far enough to parse safely.
 */
function StreamingToolCallTracer({ toolCall }: { toolCall: GenUIToolCall }) {
  const partial = tryParsePartialJson(toolCall.arguments)
  const hint = extractPartialHint(partial)
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
      </div>
    </div>
  )
}

type ParseFailure =
  | { type: 'invalid_json' }
  | { type: 'render_exception' }
  | {
      type: 'schema_invalid'
      issues?: Array<{ code: string; path: Array<string | number> }>
    }

function ParseFailureCard({
  toolName,
  failure,
  onRetry,
  onRetryToolCall,
  onRepairSuccess,
  logFailure = true,
}: {
  toolName: string
  failure: ParseFailure
  onRetry?: () => void
  onRetryToolCall?: () => Promise<boolean>
  onRepairSuccess?: () => void
  logFailure?: boolean
}) {
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryFailure, setRetryFailure] =
    useState<ArtifactRetryErrorCode | null>(null)
  const primaryIssue =
    failure.type === 'schema_invalid' ? failure.issues?.[0] : undefined
  const issueSummary = primaryIssue
    ? `${primaryIssue.path.join('.') || 'root'} (${primaryIssue.code})`
    : undefined

  // Logging is a side effect — kept out of render so React's render-twice
  // strict mode and re-renders from parent state changes don't produce
  // duplicate log lines for the same failure.
  useEffect(() => {
    if (!logFailure) return
    logError('GenUI arguments could not be rendered', new Error(failure.type), {
      component: 'GenUIToolCallRenderer',
      action: 'render',
      metadata: {
        toolName,
        failure: failure.type,
        issues: issueSummary,
      },
    })
  }, [toolName, failure.type, issueSummary, logFailure])

  const handleRetryToolCall = async () => {
    if (isRetrying) return
    if (!onRetryToolCall) return
    setIsRetrying(true)
    try {
      const repaired = await onRetryToolCall()
      setRetryFailure(repaired ? null : 'unavailable_target')
      if (repaired) onRepairSuccess?.()
      // On success the patched arguments re-render the widget and this
      // card unmounts on its own.
    } catch (error) {
      setRetryFailure(
        error instanceof ArtifactRetryError ? error.code : 'request_failed',
      )
    } finally {
      setIsRetrying(false)
    }
  }

  const retryFailureDescriptions: Record<ArtifactRetryErrorCode, string> = {
    request_failed: 'Could not request a replacement. Try the widget again.',
    schema_conversion_failed:
      'Could not prepare the component schema. Try again.',
    incomplete_replacement:
      'The replacement was incomplete or invalid JSON. Try the widget again.',
    schema_invalid_replacement:
      'The replacement did not match the component schema. Try again.',
    stale_target:
      'The component changed while retrying. Try its current version.',
    unavailable_target: 'The component is no longer available to repair.',
  }
  const description = retryFailure
    ? retryFailureDescriptions[retryFailure]
    : failure.type === 'invalid_json'
      ? 'The component data is not valid JSON.'
      : failure.type === 'render_exception'
        ? `The ${prettyWidgetName(toolName)} component ran into a problem while rendering.`
        : issueSummary
          ? `The component data failed schema validation at ${issueSummary}.`
          : `The response didn't match the ${toolName} widget's expected shape.`

  return (
    <div className="my-4 flex flex-col items-stretch gap-3 rounded-lg border border-border-subtle bg-surface-card px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-content-primary">
          Couldn&apos;t display {prettyWidgetName(toolName)}
        </span>
        <span className="text-xs text-content-muted">{description}</span>
      </div>
      <div className="flex w-full flex-shrink-0 flex-col items-stretch gap-2 md:w-auto md:flex-row md:items-center">
        {onRetryToolCall && (
          <button
            type="button"
            onClick={() => void handleRetryToolCall()}
            disabled={isRetrying}
            className="inline-flex w-full flex-shrink-0 items-center justify-center gap-1.5 rounded-md border border-brand-accent-dark bg-brand-accent-dark px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90 disabled:cursor-default disabled:opacity-60 md:w-auto"
          >
            <TfRefresh1
              className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`}
            />
            {isRetrying ? 'Fixing widget...' : 'Retry widget'}
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            className="inline-flex w-full flex-shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm font-medium text-content-primary transition-colors hover:bg-surface-card disabled:cursor-default disabled:opacity-60 md:w-auto"
          >
            Regenerate response
          </button>
        )}
      </div>
    </div>
  )
}
