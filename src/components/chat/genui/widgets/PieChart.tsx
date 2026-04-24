import {
  Cell,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { z } from 'zod'
import { coerceArray, type ChartRow } from '../input-coercion'
import { defineGenUIWidget } from '../types'

const DEFAULT_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
]

const schema = z.object({
  data: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .min(1)
    .describe('Slices as [{"name":"A","value":10}, ...]'),
  nameKey: z.string().optional(),
  valueKey: z.string().optional(),
  title: z.string().optional(),
})

function inferPieKeys(
  data: Record<string, string | number>[],
  preferredName?: string,
  preferredValue?: string,
): { nameKey: string; valueKey: string } {
  const first = data[0] ?? {}
  const keys = Object.keys(first)
  let nameKey =
    preferredName && preferredName in first ? preferredName : undefined
  let valueKey =
    preferredValue && preferredValue in first ? preferredValue : undefined
  if (!nameKey) {
    nameKey = keys.find((k) => typeof first[k] === 'string') ?? keys[0]
  }
  if (!valueKey) {
    valueKey = keys.find((k) => k !== nameKey && typeof first[k] === 'number')
  }
  if (!valueKey) valueKey = keys.find((k) => k !== nameKey) ?? keys[0]
  return { nameKey: nameKey || 'name', valueKey: valueKey || 'value' }
}

export const widget = defineGenUIWidget({
  name: 'render_pie_chart',
  description:
    'Render a pie chart for proportional data. Use when showing how parts make up a whole.',
  schema,
  promptHint: 'parts of a whole as a pie chart',
  render: ({ data, nameKey, valueKey, title }) => {
    const rows = coerceArray<ChartRow>(data)
    const keys = inferPieKeys(rows, nameKey, valueKey)
    return (
      <div className="my-3">
        {title && (
          <p className="mb-2 text-sm font-medium text-content-primary">
            {title}
          </p>
        )}
        <div className="rounded-lg border border-border-subtle p-4">
          <ResponsiveContainer width="100%" height={300}>
            <RechartsPieChart>
              <Pie
                data={rows}
                dataKey={keys.valueKey}
                nameKey={keys.nameKey}
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={({
                  name,
                  percent,
                }: {
                  name?: string
                  percent?: number
                }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                labelLine={true}
              >
                {rows.map((_, index) => (
                  <Cell
                    key={index}
                    fill={DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--surface-chat-background))',
                  border: '1px solid hsl(var(--border-subtle))',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  color: 'hsl(var(--content-primary))',
                }}
              />
            </RechartsPieChart>
          </ResponsiveContainer>
        </div>
      </div>
    )
  },
})
