import {
  Bar,
  CartesianGrid,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { z } from 'zod'
import { coerceArray, type ChartRow } from '../input-coercion'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  data: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .min(1)
    .describe(
      'Data points sharing the same keys — e.g. [{"label":"A","value":10}, ...]',
    ),
  xKey: z
    .string()
    .optional()
    .describe('Key for category axis (defaults to the first string field)'),
  yKey: z
    .string()
    .optional()
    .describe('Key for numeric axis (defaults to the first numeric field)'),
  title: z.string().optional(),
  color: z.string().optional().describe('Bar color'),
})

function inferChartKeys(
  data: Record<string, string | number>[],
  preferredX?: string,
  preferredY?: string,
): { xKey: string; yKey: string } {
  const allKeys = new Set<string>()
  for (const row of data) {
    for (const key of Object.keys(row)) allKeys.add(key)
  }
  const keys = Array.from(allKeys)

  const isNumericKey = (key: string) =>
    data.some((row) => typeof row[key] === 'number')
  const isStringKey = (key: string) =>
    data.some((row) => typeof row[key] === 'string')

  let xKey = preferredX && allKeys.has(preferredX) ? preferredX : undefined
  let yKey = preferredY && allKeys.has(preferredY) ? preferredY : undefined
  if (!xKey) xKey = keys.find(isStringKey) ?? keys[0]
  if (!yKey) yKey = keys.find((k) => k !== xKey && isNumericKey(k))
  if (!yKey) yKey = keys.find((k) => k !== xKey) ?? keys[0]
  return { xKey: xKey || 'label', yKey: yKey || 'value' }
}

export const widget = defineGenUIWidget({
  name: 'render_bar_chart',
  description:
    'Render a bar chart for categorical comparisons. Use when comparing values across categories.',
  schema,
  promptHint: 'categorical comparisons as bars',
  render: ({ data, xKey, yKey, title, color = '#3b82f6' }) => {
    const rows = coerceArray<ChartRow>(data)
    const keys = inferChartKeys(rows, xKey, yKey)
    return (
      <div className="my-3">
        {title && (
          <p className="mb-2 text-sm font-medium text-content-primary">
            {title}
          </p>
        )}
        <div className="rounded-lg border border-border-subtle p-4">
          <ResponsiveContainer width="100%" height={300}>
            <RechartsBarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" />
              <XAxis
                dataKey={keys.xKey}
                tick={{ fontSize: 12 }}
                stroke="currentColor"
              />
              <YAxis tick={{ fontSize: 12 }} stroke="currentColor" />
              <Tooltip
                cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                contentStyle={{
                  backgroundColor: 'hsl(var(--surface-chat-background))',
                  border: '1px solid hsl(var(--border-subtle))',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  color: 'hsl(var(--content-primary))',
                }}
              />
              <Bar dataKey={keys.yKey} fill={color} radius={[4, 4, 0, 0]} />
            </RechartsBarChart>
          </ResponsiveContainer>
        </div>
      </div>
    )
  },
})
