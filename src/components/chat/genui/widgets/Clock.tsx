import { Card } from '@/components/ui/card'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  label: z
    .string()
    .optional()
    .describe('Short label for this clock, e.g. "New York"'),
  timeZone: z
    .string()
    .optional()
    .describe('IANA time zone, e.g. "America/New_York". Defaults to local.'),
  showSeconds: z
    .boolean()
    .optional()
    .describe('Include the second hand (default true)'),
  showDate: z.boolean().optional().describe('Include date line (default true)'),
})

// How often to redraw the digital readout (the analog face is redrawn every
// animation frame so hands sweep smoothly, but re-formatting the digital
// string at 60fps is wasteful).
const DIGITAL_TICK_INTERVAL_MS = 1000

// Analog dial geometry.
const SIZE = 200
const CENTER = SIZE / 2
const RADIUS = CENTER - 6
const HOUR_NUMERAL_RADIUS = RADIUS - 16
const MAJOR_TICK_INNER = RADIUS - 10
const MAJOR_TICK_OUTER = RADIUS - 2
const MINOR_TICK_INNER = RADIUS - 5
const MINOR_TICK_OUTER = RADIUS - 2
const HOUR_HAND_LENGTH = RADIUS - 55
const MINUTE_HAND_LENGTH = RADIUS - 25
const SECOND_HAND_LENGTH = RADIUS - 18

interface TimeParts {
  hour: number
  minute: number
  second: number
}

function getTimeParts(date: Date, timeZone: string | undefined): TimeParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const lookup = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? '0')
    // The Intl formatter truncates to whole seconds; blend the millisecond
    // component of the Date back in so the second hand sweeps smoothly.
    const fractional = date.getMilliseconds() / 1000
    return {
      hour: lookup('hour') % 24,
      minute: lookup('minute'),
      second: lookup('second') + fractional,
    }
  } catch {
    return {
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds() + date.getMilliseconds() / 1000,
    }
  }
}

function formatTime(
  date: Date,
  timeZone: string | undefined,
  showSeconds: boolean,
): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: showSeconds ? '2-digit' : undefined,
      hour12: false,
    }).format(date)
  } catch {
    return date.toTimeString().slice(0, showSeconds ? 8 : 5)
  }
}

function formatDate(date: Date, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date)
  } catch {
    return date.toDateString()
  }
}

function polar(angleDeg: number, radius: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: CENTER + radius * Math.cos(rad),
    y: CENTER + radius * Math.sin(rad),
  }
}

function Dial({
  parts,
  showSeconds,
}: {
  parts: TimeParts
  showSeconds: boolean
}) {
  const { hour, minute, second } = parts
  const hourAngle = ((hour % 12) + minute / 60 + second / 3600) * 30
  const minuteAngle = (minute + second / 60) * 6
  const secondAngle = second * 6

  const hourHand = polar(hourAngle, HOUR_HAND_LENGTH)
  const minuteHand = polar(minuteAngle, MINUTE_HAND_LENGTH)
  const secondHand = polar(secondAngle, SECOND_HAND_LENGTH)

  const ticks: JSX.Element[] = []
  for (let i = 0; i < 60; i++) {
    const isMajor = i % 5 === 0
    const angle = i * 6
    const outer = polar(angle, isMajor ? MAJOR_TICK_OUTER : MINOR_TICK_OUTER)
    const inner = polar(angle, isMajor ? MAJOR_TICK_INNER : MINOR_TICK_INNER)
    ticks.push(
      <line
        key={i}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke="currentColor"
        strokeOpacity={isMajor ? 0.7 : 0.25}
        strokeWidth={isMajor ? 2 : 1}
        strokeLinecap="round"
      />,
    )
  }

  const numerals: JSX.Element[] = []
  for (let h = 1; h <= 12; h++) {
    const { x, y } = polar(h * 30, HOUR_NUMERAL_RADIUS)
    numerals.push(
      <text
        key={h}
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={14}
        fontWeight={600}
        fill="currentColor"
        className="font-mono"
      >
        {h}
      </text>,
    )
  }

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="h-40 w-40 text-content-primary"
      role="img"
      aria-label="Clock face"
    >
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={1}
      />
      {ticks}
      {numerals}
      {/* Hour hand */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={hourHand.x}
        y2={hourHand.y}
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
      />
      {/* Minute hand */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={minuteHand.x}
        y2={minuteHand.y}
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      {/* Second hand */}
      {showSeconds && (
        <line
          x1={CENTER}
          y1={CENTER}
          x2={secondHand.x}
          y2={secondHand.y}
          stroke="#ef4444"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      )}
      <circle cx={CENTER} cy={CENTER} r={3.5} fill="currentColor" />
      {showSeconds && <circle cx={CENTER} cy={CENTER} r={1.5} fill="#ef4444" />}
    </svg>
  )
}

function Clock({
  label,
  timeZone,
  showSeconds = true,
  showDate = true,
}: z.infer<typeof schema>) {
  // `frame` advances every animation frame so the analog hands sweep
  // smoothly. We deliberately ignore its value — it's only here to trigger
  // a re-render. The actual time is read from `Date.now()` fresh each render.
  const [, setFrame] = useState(0)
  // Digital readouts re-render once per second, since re-formatting the
  // string at 60fps is wasteful.
  const [digitalTick, setDigitalTick] = useState(() => Date.now())
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const loop = () => {
      setFrame((n) => (n + 1) % 1_000_000)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(
      () => setDigitalTick(Date.now()),
      DIGITAL_TICK_INTERVAL_MS,
    )
    return () => clearInterval(id)
  }, [])

  const now = new Date()
  const parts = getTimeParts(now, timeZone)
  const digitalNow = new Date(digitalTick)
  return (
    <Card className="my-3 max-w-xs">
      <div className="flex flex-col items-center gap-2 p-5">
        {label && (
          <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
            {label}
          </p>
        )}
        <Dial parts={parts} showSeconds={showSeconds} />
        <p className="font-mono text-xl font-semibold tabular-nums text-content-primary">
          {formatTime(digitalNow, timeZone, showSeconds)}
        </p>
        {showDate && (
          <p className="text-xs text-content-muted">
            {formatDate(digitalNow, timeZone)}
            {timeZone ? ` · ${timeZone}` : ''}
          </p>
        )}
      </div>
    </Card>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_clock',
  description:
    'Display a live analog clock face with hour/minute/second hands, optionally for a specific time zone. Use when the user asks for the current time or wants to see a clock for a named location.',
  schema,
  promptHint:
    'a live analog clock face with hands and hour numerals, optionally for a time zone',
  render: (args) => <Clock {...args} />,
})
