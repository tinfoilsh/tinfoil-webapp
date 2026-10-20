// Browser renderers. Tool declarations, prompts, and argument validation
// live in the harness, which sends a widget's arguments once they match its
// declaration.
import type { JSX } from 'react'
import type { WidgetArgs } from './widget-args'

/**
 * Types a widget's renderers by its tool name, and erases the arguments for
 * storage in the registry array.
 *
 * Usage inside a widget file:
 * ```
 * export const widget = defineGenUIWidget({
 *   name: 'render_x',
 *   render: (args) => <...>, // args is typed from the harness's declaration
 * })
 * ```
 */
export function defineGenUIWidget<Name extends keyof WidgetArgs>(
  widget: GenUIWidget<WidgetArgs[Name]> & { name: Name },
): GenUIWidget {
  return widget as GenUIWidget
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

export interface GenUIWidget<Args = any> {
  /** Tool name sent to the model. Must be unique and `render_*` snake_case. */
  name: string

  /** Inline render. */
  render?: (args: Args, ctx: GenUIRenderContext) => JSX.Element | null
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
  // The harness found the stored arguments no longer match the widget.
  invalidArguments?: boolean
}
