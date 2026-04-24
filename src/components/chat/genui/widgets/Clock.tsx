import { Card } from '@/components/ui/card'
import { useEffect, useState } from 'react'
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
    .describe('Include seconds (default true)'),
  showDate: z.boolean().optional().describe('Include date line (default true)'),
})

const TICK_INTERVAL_MS = 1000

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

function Clock({
  label,
  timeZone,
  showSeconds = true,
  showDate = true,
}: z.infer<typeof schema>) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  return (
    <Card className="my-3 max-w-sm">
      <div className="flex flex-col gap-1 p-5">
        {label && (
          <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
            {label}
          </p>
        )}
        <p className="font-mono text-3xl font-semibold tabular-nums text-content-primary">
          {formatTime(now, timeZone, showSeconds)}
        </p>
        {showDate && (
          <p className="text-xs text-content-muted">
            {formatDate(now, timeZone)}
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
    'Display a live clock, optionally for a specific time zone. Use when the user asks for the current time or wants to see a clock for a named location.',
  schema,
  promptHint: 'a live clock for the current time or a specific time zone',
  render: (args) => <Clock {...args} />,
})
