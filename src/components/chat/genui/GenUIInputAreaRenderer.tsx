/**
 * Wrapper component that mounts an input-surface widget inside `ChatInput`.
 *
 * `ChatInput` delegates rendering to this component when a pending
 * input-surface tool call exists. The wrapper owns the `resolve` / `cancel`
 * plumbing so individual widgets only deal with their own UI.
 */
import { memo } from 'react'
import type { PendingInputToolCall } from './pending-input-tool-call'
import { renderGenUIInputArea } from './render'

interface GenUIInputAreaRendererProps {
  pending: PendingInputToolCall
  isDarkMode?: boolean
  onResolve: (
    toolCallId: string,
    resultText: string,
    resultData?: unknown,
  ) => void
  onCancel?: (toolCallId: string) => void
}

export const GenUIInputAreaRenderer = memo(function GenUIInputAreaRenderer({
  pending,
  isDarkMode,
  onResolve,
  onCancel,
}: GenUIInputAreaRendererProps) {
  const rendered = renderGenUIInputArea(pending.name, pending.args, {
    toolCallId: pending.toolCallId,
    isDarkMode,
    resolve: (resultText, resultData) =>
      onResolve(pending.toolCallId, resultText, resultData),
    cancel: onCancel ? () => onCancel(pending.toolCallId) : undefined,
  })

  if (!rendered) {
    return (
      <div className="py-2 text-sm text-content-muted">
        Unable to render component: {pending.name}
      </div>
    )
  }

  return <>{rendered}</>
})
