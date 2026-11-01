// Browser renderer contracts. Tool declarations and prompts live in the harness.
import type { JSX } from 'react'
import type { ZodTypeAny, z } from 'zod'

/**
 * Helper that preserves specific-schema type inference inside a widget
 * definition while yielding a `GenUIWidget` with the schema erased to
 * `ZodTypeAny` for storage in the registry array.
 *
 * Usage inside a widget file:
 * ```
 * export const widget = defineGenUIWidget({
 *   name: 'render_x',
 *   schema: z.object({ ... }),
 *   render: (args) => <...>, // args is typed from the schema
 * })
 * ```
 */
export function defineGenUIWidget<Schema extends ZodTypeAny>(
  widget: GenUIWidget<Schema>,
): GenUIWidget {
  return widget as unknown as GenUIWidget
}

/**
 * Context passed to all widgets when rendering.
 */
export interface GenUIRenderContext {
  result?: unknown
  isActive?: boolean
  isDarkMode?: boolean
  isStreaming?: boolean
  toolCallId?: string
}

/**
 * Context passed to widgets that mount inside the chat input area
 * (`surface: 'input'`). Adds a `resolve` callback that submits the user's
 * choice as a synthetic user message and unmounts the widget.
 */
export interface GenUIInputContext extends GenUIRenderContext {
  toolCallId: string
  /**
   * Submit the user's choice. `resultText` becomes the next user message.
   * Optional `resultData` is persisted on the resolved tool-call block for
   * future reference (e.g. "which option did the user pick").
   */
  resolve: (resultText: string, resultData?: unknown) => void
  /**
   * Optional skip / dismiss affordance — widgets opt into this by rendering
   * a cancel button. Not all input-surface widgets support skipping.
   */
  cancel?: () => void
}

/**
 * Where a widget renders.
 *
 * - `inline` — inside the chat scroll as part of the assistant message.
 * - `input` — replaces the chat input textarea until the user resolves it.
 * - `artifact` — (future) compact inline summary + mounted in a sidebar.
 */
export type GenUIWidgetSurface = 'inline' | 'input' | 'artifact'

export interface GenUIWidget<Schema extends ZodTypeAny = ZodTypeAny> {
  /** Tool name sent to the model. Must be unique and `render_*` snake_case. */
  name: string
  /** Validates renderer arguments received from the harness. */
  schema: Schema
  /** Where this widget renders (default `'inline'`). */
  surface?: GenUIWidgetSurface

  /** Inline render (default surface). */
  render?: (
    args: z.infer<Schema>,
    ctx: GenUIRenderContext,
  ) => JSX.Element | null

  /** Input-area render. Required when `surface === 'input'`. */
  renderInputArea?: (
    args: z.infer<Schema>,
    ctx: GenUIInputContext,
  ) => JSX.Element | null

  /**
   * Optional compact stamp shown inline after the user resolves an
   * input-surface widget. When omitted, the widget leaves no trace in the
   * chat scroll once resolved.
   */
  renderResolved?: (
    args: z.infer<Schema>,
    resolution: GenUIToolResolution,
    ctx: GenUIRenderContext,
  ) => JSX.Element | null
}

/**
 * A tool call as tracked during streaming.
 *
 * `arguments` is the raw JSON string accumulated from streaming
 * `delta.tool_calls[].function.arguments` chunks.
 */
export interface GenUIToolCall {
  result?: unknown
  id: string
  name: string
  arguments: string
}

/**
 * Persisted resolution of an input-surface tool call.
 */
export interface GenUIToolResolution {
  text: string
  data?: unknown
  resolvedAt: number
}
