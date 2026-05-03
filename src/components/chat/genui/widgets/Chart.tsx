import {
  Bar,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  BarChart as RechartsBarChart,
  LineChart as RechartsLineChart,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { z } from 'zod'
import { coerceArray, type ChartRow } from '../input-coercion'
import { defineGenUIWidget } from '../types'

const DEFAULT_PIE_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
]

const DEFAULT_SERIES_COLOR = '#3b82f6'
const CHART_HEIGHT = 300
const PIE_OUTER_RADIUS = 100

const schema = z.object({
  type: z
    .enum(['bar', 'line', 'pie'])
    .describe(
      'Chart type. "bar" for categorical comparisons, "line" for trends or sequences, "pie" for parts of a whole.',
    ),
  data: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .min(1)
    .describe(
      'Data points sharing the same keys — e.g. [{"label":"A","value":10}, ...]',
    ),
  xKey: z
    .string()
    .optional()
    .describe(
      'For bar/line: key for the category axis. For pie: key for slice names. Defaults to the first string field.',
    ),
  yKey: z
    .string()
    .optional()
    .describe(
      'For bar/line: key for the numeric axis. For pie: key for slice values. Defaults to the first numeric field.',
    ),
  title: z.string().optional(),
  color: z
    .string()
    .optional()
    .describe(
      'Primary series color for bar/line charts. Pie slices use a built-in palette.',
    ),
})

type ChartArgs = z.infer<typeof schema>

function inferChartKeys(
  data: ChartRow[],
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

const tooltipContentStyle = {
  backgroundColor: 'hsl(var(--surface-chat-background))',
  border: '1px solid hsl(var(--border-subtle))',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  color: 'hsl(var(--content-primary))',
}

function ChartFrame({
  title,
  children,
}: {
  title?: string
  children: JSX.Element
}) {
  return (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="rounded-lg border border-border-subtle p-4">
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function renderBar(
  rows: ChartRow[],
  xKey: string,
  yKey: string,
  color: string,
) {
  return (
    <RechartsBarChart data={rows}>
      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" />
      <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="currentColor" />
      <YAxis tick={{ fontSize: 12 }} stroke="currentColor" />
      <Tooltip
        cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
        contentStyle={tooltipContentStyle}
      />
      <Bar dataKey={yKey} fill={color} radius={[4, 4, 0, 0]} />
    </RechartsBarChart>
  )
}

function renderLine(
  rows: ChartRow[],
  xKey: string,
  yKey: string,
  color: string,
) {
  return (
    <RechartsLineChart data={rows}>
      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" />
      <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="currentColor" />
      <YAxis tick={{ fontSize: 12 }} stroke="currentColor" />
      <Tooltip
        cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
        contentStyle={tooltipContentStyle}
      />
      <Line
        type="monotone"
        dataKey={yKey}
        stroke={color}
        strokeWidth={2}
        dot={{ r: 4 }}
        activeDot={{ r: 6 }}
      />
    </RechartsLineChart>
  )
}

function renderPie(rows: ChartRow[], nameKey: string, valueKey: string) {
  return (
    <RechartsPieChart>
      <Pie
        data={rows}
        dataKey={valueKey}
        nameKey={nameKey}
        cx="50%"
        cy="50%"
        outerRadius={PIE_OUTER_RADIUS}
        label={({ name, percent }: { name?: string; percent?: number }) =>
          `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`
        }
        labelLine={true}
      >
        {rows.map((_, index) => (
          <Cell
            key={index}
            fill={DEFAULT_PIE_COLORS[index % DEFAULT_PIE_COLORS.length]}
          />
        ))}
      </Pie>
      <Tooltip contentStyle={tooltipContentStyle} />
    </RechartsPieChart>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_chart',
  description:
    'Render a chart from tabular data. Choose `type`: "bar" for categorical comparisons, "line" for trends or sequences over time, "pie" for proportions/parts of a whole.',
  schema,
  promptHint:
    'a chart from tabular data — pass type "bar" | "line" | "pie" depending on whether you are comparing categories, showing a trend, or showing parts of a whole',
  render: ({ type, data, xKey, yKey, title, color }: ChartArgs) => {
    const rows = coerceArray<ChartRow>(data)
    const keys = inferChartKeys(rows, xKey, yKey)
    const seriesColor = color ?? DEFAULT_SERIES_COLOR
    let chart: JSX.Element
    if (type === 'pie') {
      chart = renderPie(rows, keys.xKey, keys.yKey)
    } else if (type === 'line') {
      chart = renderLine(rows, keys.xKey, keys.yKey, seriesColor)
    } else {
      chart = renderBar(rows, keys.xKey, keys.yKey, seriesColor)
    }
    return <ChartFrame title={title}>{chart}</ChartFrame>
  },
})
