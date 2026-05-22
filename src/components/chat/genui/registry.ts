/**
 * GenUI widget registry.
 *
 * This file is the single entry point for every model-renderable widget.
 * Widgets are plain modules under `./widgets/` that export a `widget:
 * GenUIWidget`. Adding a widget is: create a file, import it here, add it to
 * the array. Nothing else needs to change.
 *
 * `buildGenUIToolSchemas` derives the OpenAI `tools` request field from each
 * widget's Zod schema so tool definitions and render implementations never
 * drift.
 */
import { zodToJsonSchema } from 'zod-to-json-schema'
import { resolveEnabledWidgets } from './enabled-widgets'
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
import { widget as SuggestInstallingComputerUse } from './widgets/SuggestInstallingComputerUse'
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
  // Conditionally-exposed: defaultExpose: false. Renders via the registry but
  // tool-schema inclusion is driven by `computerUseRequestTools` (broker
  // absent + macOS + vision model).
  SuggestInstallingComputerUse,
]

/**
 * Lookup table keyed by tool name.
 */
export const GENUI_WIDGETS_BY_NAME: Record<string, GenUIWidget> =
  Object.fromEntries(GENUI_WIDGETS.map((w) => [w.name, w]))

/**
 * Router-internal flag the model router uses to recognise client tools that
 * have no real side effect: the router synthesises a constant tool result
 * and loops the model so the answer keeps flowing past the widget call
 * instead of ending the turn at the tool boundary. The router strips this
 * field before forwarding the request upstream.
 */
const ROUTER_AUTO_CONTINUE_FLAG = 'x-tinfoil-tool-auto-continue' as const

/**
 * Build the OpenAI `tools` array sent with chat completion requests.
 *
 * Only widgets currently allowed by the controlplane's `enabledWidgets`
 * allowlist are emitted. When no controlplane config is loaded yet, every
 * registered widget is exposed so the first-render path keeps working.
 *
 * Every GenUI tool opts into router-side auto-continuation so the model
 * keeps talking after the widget call instead of leaving the response to
 * cut off mid-thought.
 */
export function buildGenUIToolSchemas() {
  return resolveEnabledWidgets()
    .filter((w) => w.defaultExpose !== false)
    .map((w) => ({
      type: 'function' as const,
      function: {
        name: w.name,
        description: w.description,
        parameters: zodToJsonSchema(w.schema, {
          target: 'openApi3',
          $refStrategy: 'none',
        }) as Record<string, unknown>,
        [ROUTER_AUTO_CONTINUE_FLAG]: true,
      },
    }))
}

/**
 * True if the given tool name corresponds to a registered GenUI widget.
 *
 * Uses `hasOwn` so prototype keys like `toString` or `constructor`, which
 * the model could theoretically emit, do not get treated as registered.
 */
export function isGenUIToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENUI_WIDGETS_BY_NAME, name)
}
