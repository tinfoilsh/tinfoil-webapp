import { Card } from '@/components/ui/card'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  target: z
    .string()
    .describe(
      'ISO date-time the countdown targets, e.g. "2026-12-31T23:59:59Z"',
    ),
  label: z
    .string()
    .optional()
    .describe('Optional label replacing the auto-formatted target date'),
  title: z.string().optional(),
  description: z.string().optional(),
  showSeconds: z.boolean().optional(),
  completedMessage: z
    .string()
    .optional()
    .describe('Message shown after the target passes'),
})

const TICK_INTERVAL_MS = 1000

interface Remaining {
  totalMs: number
  days: number
  hours: number
  minutes: number
  seconds: number
  done: boolean
}

function parseTarget(value: string): Date | null {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

function computeRemaining(target: Date, now: Date): Remaining {
  const totalMs = target.getTime() - now.getTime()
  if (totalMs <= 0) {
    return {
      totalMs: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      done: true,
    }
  }
  const totalSeconds = Math.floor(totalMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return { totalMs, days, hours, minutes, seconds, done: false }
}

function formatTargetLabel(target: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(target)
  } catch {
    return target.toString()
  }
}

function Cell({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="rounded-lg bg-surface-chat-background px-3 py-2 font-mono text-2xl font-semibold tabular-nums text-content-primary">
        {String(value).padStart(2, '0')}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-content-muted">
        {label}
      </span>
    </div>
  )
}

function Countdown({
  target,
  label,
  title,
  description,
  showSeconds = true,
  completedMessage,
}: z.infer<typeof schema>) {
  const targetDate = useMemo(() => parseTarget(target), [target])
  const [now, setNow] = useState(() => new Date())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!targetDate) return
    intervalRef.current = setInterval(() => {
      setNow(new Date())
    }, TICK_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [targetDate])

  if (!targetDate) {
    return (
      <div className="my-3 flex w-full justify-center">
        <Card className="w-full max-w-md">
          <div className="p-5 text-sm text-content-muted">
            Invalid target date.
          </div>
        </Card>
      </div>
    )
  }

  const remaining = computeRemaining(targetDate, now)
  const targetLabel = label ?? formatTargetLabel(targetDate)

  return (
    <div className="my-3 flex w-full justify-center">
      <Card className="w-full max-w-md">
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-col gap-0.5">
            {title && (
              <p className="text-sm font-semibold text-content-primary">
                {title}
              </p>
            )}
            <p className="text-xs text-content-muted">
              {remaining.done ? 'Target' : 'Counting down to'} {targetLabel}
            </p>
          </div>

          {remaining.done ? (
            <div className="rounded-lg border border-border-subtle bg-surface-chat-background px-4 py-3 text-sm font-medium text-content-primary">
              {completedMessage ?? 'Time is up.'}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <Cell value={remaining.days} label="Days" />
              <Cell value={remaining.hours} label="Hrs" />
              <Cell value={remaining.minutes} label="Min" />
              {showSeconds && <Cell value={remaining.seconds} label="Sec" />}
            </div>
          )}

          {description && (
            <p className="text-xs text-content-muted">{description}</p>
          )}
        </div>
      </Card>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_countdown',
  description:
    'Display a live countdown toward a target date/time. Use for deadlines, launches, events, and time-sensitive moments.',
  schema,
  promptHint: 'a live countdown toward a target date/time',
  render: (args) => <Countdown {...args} />,
})
