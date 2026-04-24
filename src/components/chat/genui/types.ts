/**
 * Generative UI widget abstraction.
 *
 * A `GenUIWidget` is a self-contained module: it declares everything the rest
 * of the system needs to know about a model-renderable component — its tool
 * name/description, its Zod input schema (used as the single source of truth
 * for both JSON Schema sent to the model and runtime validation), its render
 * surface, and its React render functions.
 *
 * Adding a new widget is a single file under `./widgets/` plus one entry in
 * `./registry.ts`. The chat pipeline has no direct knowledge of any specific
 * widget — it only speaks `GenUIWidget`.
 */
import type { ZodTypeAny, z } from 'zod'

/**
 * Context passed to all widgets when rendering.
 */
export interface GenUIRenderContext {
  isDarkMode?: boolean
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
  /** Description sent to the model as the tool's description. */
  description: string
  /** Zod schema — SSOT for JSON Schema generation and runtime validation. */
  schema: Schema
  /** Where this widget renders (default `'inline'`). */
  surface?: GenUIWidgetSurface
  /**
   * One-line hint concatenated into the system prompt guidance block so the
   * model knows when to reach for this widget.
   */
  promptHint?: string

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
