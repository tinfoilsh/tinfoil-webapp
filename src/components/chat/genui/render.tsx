/**
 * GenUI rendering entry points.
 *
 * `renderGenUIInline` is the hot path used by the chat renderer. It looks up
 * the widget by name, validates the raw arguments with the widget's Zod
 * schema, and delegates to the widget's `render` function. Returns `null`
 * for unknown widgets or invalid input so callers can decide how to fall
 * back.
 *
 * `renderGenUIInputArea` mirrors the same pattern for `surface: 'input'`
 * widgets that mount inside the chat input area.
 */
import { GENUI_WIDGETS_BY_NAME } from './registry'
import type {
  GenUIInputContext,
  GenUIRenderContext,
  GenUIToolResolution,
  GenUIWidget,
} from './types'

export function getGenUIWidget(name: string): GenUIWidget | undefined {
  return GENUI_WIDGETS_BY_NAME[name]
}

export function renderGenUIInline(
  name: string,
  rawArgs: unknown,
  ctx: GenUIRenderContext,
): JSX.Element | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (!widget || !widget.render) return null
  const parsed = widget.schema.safeParse(rawArgs)
  if (!parsed.success) return null
  return widget.render(parsed.data, ctx)
}

export function renderGenUIInputArea(
  name: string,
  rawArgs: unknown,
  ctx: GenUIInputContext,
): JSX.Element | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (!widget || !widget.renderInputArea) return null
  const parsed = widget.schema.safeParse(rawArgs)
  if (!parsed.success) return null
  return widget.renderInputArea(parsed.data, ctx)
}

export function renderGenUIResolved(
  name: string,
  rawArgs: unknown,
  resolution: GenUIToolResolution,
  ctx: GenUIRenderContext,
): JSX.Element | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (!widget || !widget.renderResolved) return null
  const parsed = widget.schema.safeParse(rawArgs)
  if (!parsed.success) return null
  return widget.renderResolved(parsed.data, resolution, ctx)
}
