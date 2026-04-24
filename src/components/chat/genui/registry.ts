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
import type { GenUIWidget } from './types'
import { widget as ArtifactPreview } from './widgets/ArtifactPreview'
import { widget as AskUserInput } from './widgets/AskUserInput'
import { widget as BarChart } from './widgets/BarChart'
import { widget as Callout } from './widgets/Callout'
import { widget as Clock } from './widgets/Clock'
import { widget as ComparisonTable } from './widgets/ComparisonTable'
import { widget as ConfirmationCard } from './widgets/ConfirmationCard'
import { widget as Countdown } from './widgets/Countdown'
import { widget as DataTable } from './widgets/DataTable'
import { widget as Gauge } from './widgets/Gauge'
import { widget as Image } from './widgets/Image'
import { widget as ImageGrid } from './widgets/ImageGrid'
import { widget as InfoCard } from './widgets/InfoCard'
import { widget as KeyValueList } from './widgets/KeyValueList'
import { widget as LineChart } from './widgets/LineChart'
import { widget as LinkPreview } from './widgets/LinkPreview'
import { widget as PieChart } from './widgets/PieChart'
import { widget as ProgressBar } from './widgets/ProgressBar'
import { widget as Quote } from './widgets/Quote'
import { widget as RecipeCard } from './widgets/RecipeCard'
import { widget as SourceCards } from './widgets/SourceCards'
import { widget as StatCards } from './widgets/StatCards'
import { widget as Steps } from './widgets/Steps'
import { widget as TaskPlan } from './widgets/TaskPlan'
import { widget as Timeline } from './widgets/Timeline'

/**
 * Full widget list. Order affects nothing functionally but influences the
 * order of prompt hints presented to the model — keep frequently-useful
 * widgets near the top.
 */
export const GENUI_WIDGETS: GenUIWidget[] = [
  InfoCard,
  DataTable,
  StatCards,
  Steps,
  Callout,
  KeyValueList,
  Timeline,
  ComparisonTable,
  TaskPlan,
  BarChart,
  LineChart,
  PieChart,
  ProgressBar,
  Gauge,
  Image,
  ImageGrid,
  LinkPreview,
  SourceCards,
  ArtifactPreview,
  Clock,
  Countdown,
  Quote,
  RecipeCard,
  AskUserInput,
  ConfirmationCard,
]

/**
 * Lookup table keyed by tool name.
 */
export const GENUI_WIDGETS_BY_NAME: Record<string, GenUIWidget> =
  Object.fromEntries(GENUI_WIDGETS.map((w) => [w.name, w]))

/**
 * Build the OpenAI `tools` array sent with chat completion requests.
 */
export function buildGenUIToolSchemas() {
  return GENUI_WIDGETS.map((w) => ({
    type: 'function' as const,
    function: {
      name: w.name,
      description: w.description,
      parameters: zodToJsonSchema(w.schema, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    },
  }))
}

/**
 * True if the given tool name corresponds to a registered GenUI widget.
 */
export function isGenUIToolName(name: string): boolean {
  return name in GENUI_WIDGETS_BY_NAME
}
