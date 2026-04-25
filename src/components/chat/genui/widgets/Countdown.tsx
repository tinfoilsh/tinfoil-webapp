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

const schema = z.object({
  durationSeconds: z
    .number()
    .positive()
    .max(MAX_TIMER_SECONDS)
    .optional()
    .describe(
      'Timer duration in seconds. Prefer this for user requests like "set a 5 minute timer".',
    ),
  target: z
    .string()
    .optional()
    .describe(
      'Optional ISO date-time when the timer should end, e.g. "2026-12-31T23:59:59Z". Use only when an exact end time is known.',
    ),
  label: z
    .string()
    .optional()
    .describe('Short label shown above the timer, e.g. "Tea" or "Focus"'),
  title: z.string().optional().describe('Main timer title'),
  description: z.string().optional(),
  completedMessage: z
    .string()
    .optional()
    .describe('Message shown when the timer finishes'),
  alarmMode: alarmModeSchema
    .optional()
    .describe(
      'Alarm behavior when done. "sound" beeps; "flash" stays silent and flashes visually. Defaults to sound.',
    ),
})

type TimerAlarmMode = z.infer<typeof alarmModeSchema>
type TimerArgs = z.infer<typeof schema>

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
}: TimerArgs): TimerWindow | null {
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

function Countdown({
  durationSeconds,
  target,
  label,
  title,
  description,
  completedMessage,
  alarmMode = DEFAULT_ALARM_MODE,
}: TimerArgs) {
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

export const widget = defineGenUIWidget({
  name: 'render_countdown',
  description:
    'Display an engaging timer that ticks down from a duration, then beeps or silently flashes when done. Use for timers, breaks, reminders, workouts, cooking, and other timed activities.',
  schema,
  promptHint:
    'interactive timer with a circular countdown, sound alarm, silent flash mode, restart, and dismiss controls',
  render: (args) => <Countdown {...args} />,
})
