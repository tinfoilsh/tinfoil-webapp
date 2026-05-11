/**
 * System-prompt guidance for GenUI widgets.
 *
 * Each widget contributes its own `promptHint` line. This builder
 * concatenates them into a short section appended to the system prompt so
 * the model knows when to reach for a widget instead of markdown.
 *
 * The guidance header and the allowlist of enabled widgets come from the
 * controlplane via `getGenUIConfig()` so model-facing wording and on/off
 * gating can be tuned without a webapp release. When the controlplane
 * config hasn't been fetched yet, we fall back to a bundled header and
 * expose every registered widget.
 */
import { getGenUIConfig } from './config'
import { resolveEnabledWidgets } from './enabled-widgets'

const BUNDLED_GENUI_HEADER =
  'You have optional render_* tools available. Default to a normal markdown ' +
  'response. Only call a render_* tool when the user explicitly asks for ' +
  'one of these UI elements, or when the content genuinely cannot be ' +
  'expressed well in markdown (e.g. an interactive HTML page, a chart that ' +
  'requires plotting, an embedded live preview). Do not use render_* tools ' +
  'for ordinary informational answers, lists, tables, or summaries — write ' +
  'those as regular prose and markdown. Prefer at most one render_* call ' +
  'per response, and always pair it with a written answer rather than ' +
  'replacing the answer with a widget.'

/**
 * Returns the system-prompt hint block describing the enabled widgets, or
 * null if GenUI has been turned off (empty allowlist) or no enabled widget
 * provides a hint.
 */
export function buildGenUIPromptHint(): string | null {
  const enabled = resolveEnabledWidgets()
  if (enabled.length === 0) return null

  const hints = enabled
    .filter((w) => w.promptHint)
    .map((w) => `- ${w.name}: ${w.promptHint}`)
  if (hints.length === 0) return null

  const header = getGenUIConfig()?.header ?? BUNDLED_GENUI_HEADER
  return `${header}\n${hints.join('\n')}`
}
