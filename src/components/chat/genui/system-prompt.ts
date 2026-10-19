/**
 * System-prompt guidance for GenUI widgets.
 *
 * Each widget contributes its own `promptHint` line. This builder
 * concatenates them into a short section appended to the system prompt so
 * the model knows when to reach for a widget instead of markdown.
 *
 * The guidance header and the allowlist of enabled widgets come from the
 * controlplane via `getGenUIConfig()` so model-facing wording and on/off
 * gating can be tuned without a webapp release. Without controlplane config
 * no widgets are enabled and no hint is produced.
 */
import { getGenUIConfig } from './config'
import { resolveEnabledWidgets } from './enabled-widgets'

/**
 * Returns the system-prompt hint block describing the enabled widgets, or
 * null if GenUI has been turned off (empty allowlist) or no enabled widget
 * provides a hint.
 */
export function buildGenUIPromptHint(): string | null {
  const config = getGenUIConfig()
  if (!config) return null

  const enabled = resolveEnabledWidgets()
  if (enabled.length === 0) return null

  const hints = enabled
    .filter((w) => w.promptHint)
    .map((w) => `- ${w.name}: ${w.promptHint}`)
  if (hints.length === 0) return null

  return `${config.header}\n${hints.join('\n')}`
}
