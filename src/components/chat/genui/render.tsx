/**
 * GenUI rendering entry points.
 *
 * `renderGenUIInline` is the hot path used by the chat renderer. It looks up
 * the widget by name and delegates to the widget's `render` function with
 * the arguments the harness validated. Returns `null` for unknown widgets so
 * callers can decide how to fall back.
 */
import type { JSX } from 'react'
import { GENUI_WIDGETS_BY_NAME } from './registry'
import type {
  GenUIRenderContext,
  GenUIToolResolution,
  GenUIWidget,
} from './types'

export function getGenUIWidget(name: string): GenUIWidget | undefined {
  return GENUI_WIDGETS_BY_NAME[name]
}

export function renderGenUIInline(
  name: string,
  args: unknown,
  ctx: GenUIRenderContext,
): JSX.Element | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (!widget || !widget.render) return null
  return widget.render(args, ctx)
}

export function renderGenUIResolved(
  name: string,
  args: unknown,
  resolution: GenUIToolResolution,
  ctx: GenUIRenderContext,
): JSX.Element | null {
  const widget = GENUI_WIDGETS_BY_NAME[name]
  if (!widget || !widget.renderResolved) return null
  return widget.renderResolved(args, resolution, ctx)
}
