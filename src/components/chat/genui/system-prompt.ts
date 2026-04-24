/**
 * System-prompt guidance for GenUI widgets.
 *
 * Instead of a single opaque hint string, each widget contributes its own
 * `promptHint` line. This builder concatenates them into a short section
 * appended to the system prompt so the model knows when to reach for a
 * widget instead of markdown.
 */
import { GENUI_WIDGETS } from './registry'

const GENUI_HEADER =
  'You have render_* tools that produce rich interactive components instead ' +
  'of markdown. Prefer them whenever the content is structured (tables, ' +
  'charts, timelines, previews, comparisons, lists of sources, etc.). You ' +
  'may call multiple render tools in one response.'

/**
 * Returns the system-prompt hint block describing all registered widgets,
 * or null if no widgets are registered or provide hints.
 */
export function buildGenUIPromptHint(): string | null {
  const hints = GENUI_WIDGETS.filter((w) => w.promptHint).map(
    (w) => `- ${w.name}: ${w.promptHint}`,
  )
  if (hints.length === 0) return null
  return `${GENUI_HEADER}\n${hints.join('\n')}`
}
