import type { GenUIWidget } from './types'
import { widget as ArtifactPreview } from './widgets/ArtifactPreview'
import { widget as Chart } from './widgets/Chart'
import { widget as Clock } from './widgets/Clock'
import { widget as Image } from './widgets/Image'
import { widget as LinkPreview } from './widgets/LinkPreview'
import { widget as Map } from './widgets/Map'
import { widget as MessageCompose } from './widgets/MessageCompose'
import { widget as RecipeCard } from './widgets/RecipeCard'
import { widget as SportsData } from './widgets/SportsData'
import { widget as StatCards } from './widgets/StatCards'
import { widget as Timeline } from './widgets/Timeline'

/**
 * Full widget list. Order affects nothing functionally but influences the
 * order of prompt hints presented to the model — keep frequently-useful
 * widgets near the top.
 */
export const GENUI_WIDGETS: GenUIWidget[] = [
  StatCards,
  Timeline,
  Chart,
  Image,
  LinkPreview,
  ArtifactPreview,
  Clock,
  RecipeCard,
  MessageCompose,
  SportsData,
  Map,
]

/**
 * Lookup table keyed by tool name.
 */
export const GENUI_WIDGETS_BY_NAME: Record<string, GenUIWidget> =
  Object.fromEntries(GENUI_WIDGETS.map((w) => [w.name, w]))

/**
 * True if the given tool name corresponds to a registered GenUI widget.
 *
 * Uses `hasOwn` so prototype keys like `toString` or `constructor`, which
 * the model could theoretically emit, do not get treated as registered.
 */
export function isGenUIToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENUI_WIDGETS_BY_NAME, name)
}
