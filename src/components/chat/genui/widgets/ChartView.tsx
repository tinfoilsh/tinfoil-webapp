import type { JSX } from 'react'
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
import { coerceArray, type ChartRow } from '../input-coercion'
import type { ChartArgs } from './Chart'

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
  let yKey =
    preferredY && allKeys.has(preferredY) && isNumericKey(preferredY)
      ? preferredY
      : undefined
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

// Grid, axes, and tooltip are identical between bar and line charts apart
// from the tooltip cursor style. Returned as an array so Recharts flattens
// them into the chart's children alongside the series element.
function cartesianAxes(xKey: string, cursor: Record<string, unknown>) {
  return [
    <CartesianGrid key="grid" strokeDasharray="3 3" stroke="currentColor" />,
    <XAxis
      key="x"
      dataKey={xKey}
      tick={{ fontSize: 12 }}
      stroke="currentColor"
    />,
    <YAxis key="y" tick={{ fontSize: 12 }} stroke="currentColor" />,
    <Tooltip
      key="tooltip"
      cursor={cursor}
      contentStyle={tooltipContentStyle}
    />,
  ]
}

function renderBar(
  rows: ChartRow[],
  xKey: string,
  yKey: string,
  color: string,
) {
  return (
    <RechartsBarChart data={rows}>
      {cartesianAxes(xKey, { fill: 'currentColor', fillOpacity: 0.06 })}
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
      {cartesianAxes(xKey, { stroke: 'currentColor', strokeOpacity: 0.2 })}
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

export default function ChartView({
  type,
  data,
  xKey,
  yKey,
  title,
  color,
}: ChartArgs) {
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
}
