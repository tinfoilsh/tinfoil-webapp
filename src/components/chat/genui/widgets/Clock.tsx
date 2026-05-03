import { Card } from '@/components/ui/card'
import { Bell, BellOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const MAX_TIMER_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_ALARM_MODE = 'sound'
const TICK_INTERVAL_MS = 250
const SECOND_MS = 1000
const MINUTE_SECONDS = 60
const HOUR_SECONDS = 60 * MINUTE_SECONDS
const DAY_SECONDS = 24 * HOUR_SECONDS

const DIGITAL_TICK_INTERVAL_MS = 1000
const FACE_SIZE = 200
const FACE_CENTER = FACE_SIZE / 2
const FACE_RADIUS = FACE_CENTER - 6
const HOUR_NUMERAL_RADIUS = FACE_RADIUS - 16
const MAJOR_TICK_INNER = FACE_RADIUS - 10
const MAJOR_TICK_OUTER = FACE_RADIUS - 2
const MINOR_TICK_INNER = FACE_RADIUS - 5
const MINOR_TICK_OUTER = FACE_RADIUS - 2
const HOUR_HAND_LENGTH = FACE_RADIUS - 55
const MINUTE_HAND_LENGTH = FACE_RADIUS - 25
const SECOND_HAND_LENGTH = FACE_RADIUS - 18

const RING_SIZE = 220
const RING_CENTER = RING_SIZE / 2
const RING_RADIUS = 96
const RING_STROKE = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const ALARM_BEEP_INTERVAL_MS = 850
const ALARM_BEEP_DURATION_MS = 180
const ALARM_FREQUENCY_HZ = 880
const ALARM_GAIN = 0.07
const TIMER_ACCENT = '#f6b34b'

const alarmModeSchema = z.enum(['sound', 'flash'])

const schema = z
  .object({
    mode: z
      .enum(['clock', 'timer'])
      .optional()
      .describe(
        'What to display. "clock" shows the current time as an analog face. "timer" counts down from a duration or to a target time. Defaults to "clock".',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'Short label, e.g. "New York" for a clock or "Tea" for a timer.',
      ),
    title: z.string().optional().describe('Main title (timer mode)'),
    description: z.string().optional().describe('Optional description'),
    timeZone: z
      .string()
      .optional()
      .describe(
        'Clock mode only. IANA time zone, e.g. "America/New_York". Defaults to local.',
      ),
    showSeconds: z
      .boolean()
      .optional()
      .describe('Clock mode: include the second hand (default true).'),
    showDate: z
      .boolean()
      .optional()
      .describe('Clock mode: include date line (default true).'),
    durationSeconds: z
      .number()
      .positive()
      .max(MAX_TIMER_SECONDS)
      .optional()
      .describe(
        'Timer mode. Duration in seconds. Prefer this for requests like "set a 5 minute timer".',
      ),
    target: z
      .string()
      .optional()
      .describe(
        'Timer mode. ISO date-time when the timer should end, e.g. "2026-12-31T23:59:59Z". Use when an exact end time is known.',
      ),
    completedMessage: z
      .string()
      .optional()
      .describe('Timer mode. Message shown when the timer finishes.'),
    alarmMode: alarmModeSchema
      .optional()
      .describe(
        'Timer mode. Alarm behavior when done. "sound" beeps; "flash" stays silent and flashes visually. Defaults to sound.',
      ),
  })
  .describe(
    'Display either a live analog clock or an interactive countdown timer.',
  )

type ClockArgs = z.infer<typeof schema>
type TimerAlarmMode = z.infer<typeof alarmModeSchema>

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
    x: FACE_CENTER + radius * Math.cos(rad),
    y: FACE_CENTER + radius * Math.sin(rad),
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
      viewBox={`0 0 ${FACE_SIZE} ${FACE_SIZE}`}
      className="h-40 w-40 text-content-primary"
      role="img"
      aria-label="Clock face"
    >
      <circle
        cx={FACE_CENTER}
        cy={FACE_CENTER}
        r={FACE_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={1}
      />
      {ticks}
      {numerals}
      {/* Hour hand */}
      <line
        x1={FACE_CENTER}
        y1={FACE_CENTER}
        x2={hourHand.x}
        y2={hourHand.y}
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
      />
      {/* Minute hand */}
      <line
        x1={FACE_CENTER}
        y1={FACE_CENTER}
        x2={minuteHand.x}
        y2={minuteHand.y}
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      {/* Second hand */}
      {showSeconds && (
        <line
          x1={FACE_CENTER}
          y1={FACE_CENTER}
          x2={secondHand.x}
          y2={secondHand.y}
          stroke="#ef4444"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      )}
      <circle cx={FACE_CENTER} cy={FACE_CENTER} r={3.5} fill="currentColor" />
      {showSeconds && (
        <circle cx={FACE_CENTER} cy={FACE_CENTER} r={1.5} fill="#ef4444" />
      )}
    </svg>
  )
}

function ClockFace({
  label,
  timeZone,
  showSeconds = true,
  showDate = true,
}: {
  label?: string
  timeZone?: string
  showSeconds?: boolean
  showDate?: boolean
}) {
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
    <div className="my-3 flex w-full justify-center">
      <Card className="w-full max-w-xs">
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
    </div>
  )
}

interface TimerWindow {
  startTimeMs: number
  endTimeMs: number
}

interface Remaining {
  totalMs: number
  days: number
  hours: number
  minutes: number
  seconds: number
  done: boolean
}

function parseTargetMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  if (Number.isNaN(parsed)) return null
  return parsed
}

function getDurationMs(durationSeconds: number | undefined): number | null {
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds)
  ) {
    return null
  }
  return Math.max(SECOND_MS, Math.round(durationSeconds * SECOND_MS))
}

function createTimerWindow({
  durationSeconds,
  target,
}: {
  durationSeconds?: number
  target?: string
}): TimerWindow | null {
  const now = Date.now()
  const durationMs = getDurationMs(durationSeconds)
  if (durationMs !== null) {
    return {
      startTimeMs: now,
      endTimeMs: now + durationMs,
    }
  }

  const targetMs = parseTargetMs(target)
  if (targetMs === null) return null
  return {
    startTimeMs: now,
    endTimeMs: targetMs,
  }
}

function getTimerDurationMs(timerWindow: TimerWindow | null): number | null {
  if (!timerWindow) return null
  return Math.max(SECOND_MS, timerWindow.endTimeMs - timerWindow.startTimeMs)
}

function computeRemaining(endTimeMs: number, nowMs: number): Remaining {
  return computeRemainingMs(endTimeMs - nowMs)
}

function computeRemainingMs(value: number): Remaining {
  const totalMs = Math.max(0, value)
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

  const totalSeconds = Math.ceil(totalMs / SECOND_MS)
  const days = Math.floor(totalSeconds / DAY_SECONDS)
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / HOUR_SECONDS)
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / MINUTE_SECONDS)
  const seconds = totalSeconds % MINUTE_SECONDS
  return { totalMs, days, hours, minutes, seconds, done: false }
}

function formatDuration(remaining: Remaining): string {
  const hours = remaining.days * 24 + remaining.hours
  const parts = [hours, remaining.minutes, remaining.seconds]
  if (hours === 0) {
    return `${String(remaining.minutes).padStart(2, '0')}:${String(
      remaining.seconds,
    ).padStart(2, '0')}`
  }
  return parts.map((part) => String(part).padStart(2, '0')).join(':')
}

function formatEndTime(endTimeMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(endTimeMs))
  } catch {
    return new Date(endTimeMs).toTimeString().slice(0, 5)
  }
}

function getAudioContextClass() {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  )
}

function CountdownTimer({
  durationSeconds,
  target,
  label,
  title,
  description,
  completedMessage,
  alarmMode = DEFAULT_ALARM_MODE,
}: {
  durationSeconds?: number
  target?: string
  label?: string
  title?: string
  description?: string
  completedMessage?: string
  alarmMode?: TimerAlarmMode
}) {
  const timerKey = `${durationSeconds ?? ''}:${target ?? ''}`
  const [timerWindow, setTimerWindow] = useState<TimerWindow | null>(() =>
    createTimerWindow({ durationSeconds, target }),
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [mode, setMode] = useState<TimerAlarmMode>(alarmMode)
  const [dismissed, setDismissed] = useState(false)
  const [pausedRemainingMs, setPausedRemainingMs] = useState<number | null>(
    () => getTimerDurationMs(createTimerWindow({ durationSeconds, target })),
  )
  const [hasStarted, setHasStarted] = useState(false)
  const audioRef = useRef<AudioContext | null>(null)
  const beepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopBeeping = useCallback(() => {
    if (beepTimerRef.current) {
      clearInterval(beepTimerRef.current)
      beepTimerRef.current = null
    }
  }, [])

  const unlockAudio = useCallback(async () => {
    const AudioContextClass = getAudioContextClass()
    if (!AudioContextClass) return null
    const context = audioRef.current ?? new AudioContextClass()
    audioRef.current = context
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        return context
      }
    }
    return context
  }, [])

  const playBeep = useCallback(() => {
    const AudioContextClass = getAudioContextClass()
    if (!AudioContextClass) return
    const context = audioRef.current ?? new AudioContextClass()
    audioRef.current = context
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
      return
    }

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const start = context.currentTime
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(ALARM_FREQUENCY_HZ, start)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(ALARM_GAIN, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      start + ALARM_BEEP_DURATION_MS / SECOND_MS,
    )
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(start)
    oscillator.stop(start + ALARM_BEEP_DURATION_MS / SECOND_MS)
  }, [])

  useEffect(() => {
    const nextWindow = createTimerWindow({ durationSeconds, target })
    setTimerWindow(nextWindow)
    setNowMs(Date.now())
    setDismissed(false)
    setPausedRemainingMs(getTimerDurationMs(nextWindow))
    setHasStarted(false)
    stopBeeping()
  }, [timerKey, durationSeconds, target, stopBeeping])

  useEffect(() => {
    setMode(alarmMode)
  }, [alarmMode])

  useEffect(() => {
    if (!timerWindow) return
    const id = setInterval(() => setNowMs(Date.now()), TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [timerWindow])

  useEffect(() => {
    return () => {
      stopBeeping()
      if (audioRef.current) {
        void audioRef.current.close().catch(() => {})
        audioRef.current = null
      }
    }
  }, [stopBeeping])

  const remaining = timerWindow
    ? pausedRemainingMs !== null
      ? computeRemainingMs(pausedRemainingMs)
      : computeRemaining(timerWindow.endTimeMs, nowMs)
    : null
  const totalDurationMs = getTimerDurationMs(timerWindow) ?? SECOND_MS
  const progress =
    !remaining || remaining.done
      ? 0
      : Math.min(1, Math.max(0, remaining.totalMs / totalDurationMs))
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress)
  const isAlarmActive = !!remaining && remaining.done && !dismissed
  const isFlashing = isAlarmActive && mode === 'flash'

  useEffect(() => {
    stopBeeping()
    if (!isAlarmActive || mode !== 'sound') return
    playBeep()
    beepTimerRef.current = setInterval(playBeep, ALARM_BEEP_INTERVAL_MS)
    return stopBeeping
  }, [isAlarmActive, mode, playBeep, stopBeeping])

  if (!timerWindow) {
    return (
      <div className="my-3 flex w-full justify-center">
        <Card className="w-full max-w-sm">
          <div className="p-5 text-sm text-content-muted">
            Add a duration or valid target time to start a timer.
          </div>
        </Card>
      </div>
    )
  }
  if (!remaining) return null

  const handleToggleMode = () => {
    const nextMode: TimerAlarmMode = mode === 'sound' ? 'flash' : 'sound'
    setMode(nextMode)
    if (nextMode === 'sound') void unlockAudio()
  }

  const handleRestart = () => {
    const nextWindow = createTimerWindow({ durationSeconds, target })
    setTimerWindow(nextWindow)
    setNowMs(Date.now())
    setDismissed(false)
    setPausedRemainingMs(getTimerDurationMs(nextWindow))
    setHasStarted(false)
    stopBeeping()
  }

  const handlePauseToggle = () => {
    if (!timerWindow || remaining.done) return
    if (pausedRemainingMs !== null) {
      const now = Date.now()
      setTimerWindow({
        startTimeMs: now - (totalDurationMs - pausedRemainingMs),
        endTimeMs: now + pausedRemainingMs,
      })
      setNowMs(now)
      setPausedRemainingMs(null)
      setHasStarted(true)
      return
    }
    setPausedRemainingMs(remaining.totalMs)
  }

  const displayTitle = title ?? label ?? 'Timer'
  const scheduledEndTimeMs =
    pausedRemainingMs !== null && !remaining.done
      ? nowMs + pausedRemainingMs
      : timerWindow.endTimeMs
  const statusText = remaining.done
    ? (completedMessage ?? 'Time is up.')
    : formatEndTime(scheduledEndTimeMs)
  const alarmLabel = mode === 'sound' ? 'Sound' : 'Flash'
  const primaryActionLabel =
    pausedRemainingMs !== null ? (hasStarted ? 'Resume' : 'Start') : 'Pause'
  const secondaryActionLabel = remaining.done
    ? 'Done'
    : hasStarted
      ? 'Restart'
      : 'Reset'

  return (
    <div className="my-3 flex w-full justify-center">
      <Card
        className={`w-full max-w-sm overflow-hidden border border-border-subtle bg-white text-content-primary shadow-none transition-colors dark:border-0 dark:bg-black dark:text-white ${
          isFlashing ? 'animate-pulse' : ''
        }`}
      >
        <div className="flex flex-col items-center gap-5 p-6">
          <div className="min-w-0 text-center">
            <p className="truncate text-sm font-medium text-content-primary/80 dark:text-white/80">
              {displayTitle}
            </p>
            {description && !remaining.done && (
              <p className="mt-1 line-clamp-2 text-xs text-content-muted dark:text-white/45">
                {description}
              </p>
            )}
          </div>

          <div className="relative flex h-64 w-64 items-center justify-center">
            <svg
              viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
              className="absolute inset-0 h-full w-full -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                className="text-content-primary/10 dark:text-[#2f2f2f]"
                strokeWidth={RING_STROKE}
              />
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                stroke={TIMER_ACCENT}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={strokeDashoffset}
                className="transition-[stroke-dashoffset] duration-300 ease-linear"
              />
            </svg>
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="font-mono text-6xl font-light tabular-nums tracking-tight text-content-primary dark:text-white">
                {remaining.done ? '00:00' : formatDuration(remaining)}
              </p>
              <p className="inline-flex max-w-40 items-center gap-1.5 text-sm text-content-muted dark:text-white/45">
                {mode === 'sound' ? (
                  <Bell className="h-4 w-4" />
                ) : (
                  <BellOff className="h-4 w-4" />
                )}
                {statusText}
              </p>
            </div>
          </div>

          <div className="flex w-full items-center justify-between gap-6">
            <button
              type="button"
              onClick={() => {
                if (remaining.done) {
                  setDismissed(true)
                  stopBeeping()
                  return
                }
                handleRestart()
              }}
              className="bg-surface-secondary hover:bg-surface-secondary/80 flex h-20 w-20 items-center justify-center rounded-full border border-border-subtle text-sm font-medium text-content-primary transition-colors dark:border-white/10 dark:bg-white/[0.12] dark:text-white dark:hover:bg-white/[0.16]"
            >
              {secondaryActionLabel}
            </button>
            <button
              type="button"
              onClick={handlePauseToggle}
              className="flex h-20 w-20 items-center justify-center rounded-full text-base font-semibold transition-colors disabled:opacity-50"
              style={{
                backgroundColor: TIMER_ACCENT,
                color: '#1a1100',
              }}
              disabled={remaining.done}
            >
              {primaryActionLabel}
            </button>
          </div>

          <button
            type="button"
            onClick={handleToggleMode}
            className="bg-surface-secondary hover:bg-surface-secondary/80 flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm transition-colors dark:bg-white/[0.12] dark:hover:bg-white/[0.16]"
          >
            <span className="text-content-primary/90 dark:text-white/90">
              When Timer Ends
            </span>
            <span className="inline-flex items-center gap-2 text-content-muted dark:text-white/45">
              {alarmLabel}
              <span aria-hidden="true">›</span>
            </span>
          </button>
        </div>
      </Card>
    </div>
  )
}

function resolveMode(args: ClockArgs): 'clock' | 'timer' {
  if (args.mode) return args.mode
  if (
    typeof args.durationSeconds === 'number' ||
    (typeof args.target === 'string' && args.target.length > 0)
  ) {
    return 'timer'
  }
  return 'clock'
}

export const widget = defineGenUIWidget({
  name: 'render_clock',
  description:
    'Display either a live analog clock (mode "clock") or an interactive countdown timer (mode "timer"). Use "clock" for the current time in a time zone. Use "timer" for "set a 5 minute timer", reminders, breaks, workouts, cooking, etc.',
  schema,
  promptHint:
    'a live analog clock OR a countdown timer — pass mode "clock" with optional timeZone for time display, or mode "timer" with durationSeconds (or target ISO date) for countdowns',
  render: (args: ClockArgs) => {
    const resolved = resolveMode(args)
    if (resolved === 'timer') {
      return (
        <CountdownTimer
          durationSeconds={args.durationSeconds}
          target={args.target}
          label={args.label}
          title={args.title}
          description={args.description}
          completedMessage={args.completedMessage}
          alarmMode={args.alarmMode}
        />
      )
    }
    return (
      <ClockFace
        label={args.label}
        timeZone={args.timeZone}
        showSeconds={args.showSeconds}
        showDate={args.showDate}
      />
    )
  },
})
