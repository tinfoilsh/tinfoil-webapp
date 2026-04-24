import { Card } from '@/components/ui/card'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const gaugeZone = z.object({
  from: z.number(),
  to: z.number(),
  color: z.string(),
  label: z.string().optional(),
})

const schema = z.object({
  label: z.string().describe('Short label for what the gauge measures'),
  value: z.union([z.string(), z.number()]).describe('Current value'),
  min: z.union([z.string(), z.number()]).optional().describe('Default 0'),
  max: z.union([z.string(), z.number()]).optional().describe('Default 100'),
  unit: z
    .string()
    .optional()
    .describe('Short unit shown under the value, e.g. "mph" or "%"'),
  valueLabel: z.string().optional(),
  description: z.string().optional(),
  color: z
    .string()
    .optional()
    .describe('Accent color for the filled arc, e.g. "#3b82f6"'),
  zones: z
    .array(gaugeZone)
    .optional()
    .describe('Colored threshold zones drawn along the arc'),
  size: z.enum(['small', 'default']).optional(),
})

const VIEWBOX = 220
const RADIUS = 90
const STROKE = 18
const CENTER = VIEWBOX / 2
const BASELINE = CENTER + 20

function toNumber(
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : fallback
  const cleaned = value.replace(/[^0-9+\-.eE]/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : fallback
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = (angleDeg * Math.PI) / 180
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  }
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
) {
  const a = polarToCartesian(cx, cy, r, start)
  const b = polarToCartesian(cx, cy, r, end)
  const largeArc = Math.abs(end - start) > 180 ? 1 : 0
  // SVG arc sweep direction: clockwise for start < end
  const sweep = end >= start ? 1 : 0
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${b.x} ${b.y}`
}

export const widget = defineGenUIWidget({
  name: 'render_gauge',
  description:
    'Display a radial gauge for a single value with optional colored threshold zones. Use for speedometer-style metrics, credit scores, air quality, battery/health, or similar indicators.',
  schema,
  promptHint: 'radial gauge for a single value with optional threshold zones',
  render: ({
    label,
    value,
    min,
    max,
    unit,
    valueLabel,
    description,
    color = '#3b82f6',
    zones,
    size = 'default',
  }) => {
    const minN = toNumber(min, 0)
    const maxN = toNumber(max, 100)
    const valueN = toNumber(value, minN)
    const range = Math.max(1e-6, maxN - minN)
    const pct = Math.min(1, Math.max(0, (valueN - minN) / range))

    // Sweep from -180° (left) to 0° (right) — a half-circle gauge.
    const startAngle = -180
    const endAngle = 0
    const valueAngle = startAngle + pct * (endAngle - startAngle)

    const backgroundPath = arcPath(
      CENTER,
      BASELINE,
      RADIUS,
      startAngle,
      endAngle,
    )
    const valuePath = arcPath(CENTER, BASELINE, RADIUS, startAngle, valueAngle)

    const zonePaths = (zones ?? []).map((zone, i) => {
      const zFrom = Math.min(1, Math.max(0, (zone.from - minN) / range))
      const zTo = Math.min(1, Math.max(0, (zone.to - minN) / range))
      const a = startAngle + zFrom * (endAngle - startAngle)
      const b = startAngle + zTo * (endAngle - startAngle)
      return (
        <path
          key={i}
          d={arcPath(CENTER, BASELINE, RADIUS, a, b)}
          stroke={zone.color}
          strokeOpacity={0.35}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="butt"
        />
      )
    })

    const widthClass = size === 'small' ? 'max-w-[200px]' : 'max-w-xs'
    return (
      <Card className={`my-3 ${widthClass}`}>
        <div className="p-4">
          <p className="text-xs font-medium text-content-muted">{label}</p>
          <svg
            viewBox={`0 0 ${VIEWBOX} ${BASELINE + 10}`}
            className="mt-2 w-full"
          >
            <path
              d={backgroundPath}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
            />
            {zonePaths}
            <path
              d={valuePath}
              stroke={color}
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
            />
          </svg>
          <div className="-mt-6 text-center">
            <p className="text-2xl font-semibold text-content-primary">
              {String(value)}
            </p>
            {(valueLabel || unit) && (
              <p className="text-xs text-content-muted">{valueLabel ?? unit}</p>
            )}
          </div>
          {description && (
            <p className="mt-2 text-xs text-content-muted">{description}</p>
          )}
        </div>
      </Card>
    )
  },
})
