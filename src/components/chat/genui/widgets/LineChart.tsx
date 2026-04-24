import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
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
    .describe('Data points sharing the same keys'),
  xKey: z.string().optional(),
  yKey: z.string().optional(),
  title: z.string().optional(),
  color: z.string().optional(),
})

function inferChartKeys(
  data: Record<string, string | number>[],
  preferredX?: string,
  preferredY?: string,
): { xKey: string; yKey: string } {
  const first = data[0] ?? {}
  const keys = Object.keys(first)
  let xKey = preferredX && preferredX in first ? preferredX : undefined
  let yKey = preferredY && preferredY in first ? preferredY : undefined
  if (!xKey) xKey = keys.find((k) => typeof first[k] === 'string') ?? keys[0]
  if (!yKey) yKey = keys.find((k) => k !== xKey && typeof first[k] === 'number')
  if (!yKey) yKey = keys.find((k) => k !== xKey) ?? keys[0]
  return { xKey: xKey || 'label', yKey: yKey || 'value' }
}

export const widget = defineGenUIWidget({
  name: 'render_line_chart',
  description:
    'Render a line chart for trends over time. Use when showing how values change across a sequence.',
  schema,
  promptHint: 'trends or sequences as a line chart',
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
            <RechartsLineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" />
              <XAxis
                dataKey={keys.xKey}
                tick={{ fontSize: 12 }}
                stroke="currentColor"
              />
              <YAxis tick={{ fontSize: 12 }} stroke="currentColor" />
              <Tooltip
                cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
                contentStyle={{
                  backgroundColor: 'hsl(var(--surface-chat-background))',
                  border: '1px solid hsl(var(--border-subtle))',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  color: 'hsl(var(--content-primary))',
                }}
              />
              <Line
                type="monotone"
                dataKey={keys.yKey}
                stroke={color}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
            </RechartsLineChart>
          </ResponsiveContainer>
        </div>
      </div>
    )
  },
})
