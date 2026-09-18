'use client'

import { cn } from '@/components/ui/utils'
import { getAudioContextClass } from '@/utils/audio-context'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { CONSTANTS } from './constants'

const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000

export function formatRecordingDuration(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE)
  const seconds = whole % SECONDS_PER_MINUTE
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Root-mean-square level of an unsigned 8-bit PCM frame, in 0..1. */
function measureLevel(samples: Uint8Array): number {
  let sumOfSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const centered = (samples[i] - 128) / 128
    sumOfSquares += centered * centered
  }
  return Math.sqrt(sumOfSquares / samples.length)
}

interface RecordingWaveformProps {
  stream: MediaStream
  className?: string
  style?: CSSProperties
}

/**
 * Live microphone meter shown in place of the textarea while recording:
 * an elapsed-time counter followed by a strip of amplitude bars that scrolls
 * left as new samples arrive, in the style of messaging-app voice notes.
 */
export function RecordingWaveform({
  stream,
  className,
  style,
}: RecordingWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const startedAt = performance.now()
    const step =
      CONSTANTS.RECORDING_WAVEFORM_BAR_WIDTH_PX +
      CONSTANTS.RECORDING_WAVEFORM_BAR_GAP_PX
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let analyser: AnalyserNode | null = null
    let audioContext: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    const AudioContextClass = getAudioContextClass()
    if (AudioContextClass) {
      // A stream with no audio track makes createMediaStreamSource throw;
      // fall back to the flat-line rendering rather than tearing down the
      // recording UI.
      try {
        audioContext = new AudioContextClass()
        source = audioContext.createMediaStreamSource(stream)
        analyser = audioContext.createAnalyser()
        analyser.fftSize = CONSTANTS.RECORDING_WAVEFORM_FFT_SIZE
        source.connect(analyser)
        if (audioContext.state === 'suspended') {
          void audioContext.resume().catch(() => {})
        }
      } catch {
        source?.disconnect()
        void audioContext?.close().catch(() => {})
        audioContext = null
        source = null
        analyser = null
      }
    }
    const frame = analyser ? new Uint8Array(analyser.fftSize) : null

    // Newest level last; trimmed to what fits across the canvas plus one
    // bar that is partially scrolled off the left edge.
    const levels: number[] = []
    let lastSampleAt = startedAt
    let lastDisplayedSecond = -1
    let cssWidth = 0
    let cssHeight = 0
    let strokeColor = ''

    const ctx = canvas?.getContext('2d') ?? null

    const resize = () => {
      if (!canvas || !ctx) return
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      cssWidth = rect.width
      cssHeight = rect.height
      canvas.width = Math.round(cssWidth * dpr)
      canvas.height = Math.round(cssHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      strokeColor = getComputedStyle(canvas).color
    }
    resize()
    const resizeObserver =
      canvas && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(resize)
        : null
    resizeObserver?.observe(canvas as HTMLCanvasElement)

    const draw = (scrollOffset: number) => {
      if (!canvas || !ctx || cssWidth === 0) return
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = CONSTANTS.RECORDING_WAVEFORM_BAR_WIDTH_PX
      ctx.lineCap = 'round'
      const midY = cssHeight / 2
      const usableHeight =
        cssHeight - CONSTANTS.RECORDING_WAVEFORM_MIN_BAR_HEIGHT_PX
      ctx.beginPath()
      for (let k = 0; k < levels.length; k++) {
        const level = levels[levels.length - 1 - k]
        const x =
          cssWidth -
          scrollOffset -
          (k + 1) * step +
          CONSTANTS.RECORDING_WAVEFORM_BAR_GAP_PX / 2 +
          CONSTANTS.RECORDING_WAVEFORM_BAR_WIDTH_PX / 2
        if (x + CONSTANTS.RECORDING_WAVEFORM_BAR_WIDTH_PX < 0) break
        const amplitude = Math.min(1, level * CONSTANTS.RECORDING_WAVEFORM_GAIN)
        const barHeight =
          CONSTANTS.RECORDING_WAVEFORM_MIN_BAR_HEIGHT_PX +
          amplitude * usableHeight
        ctx.moveTo(x, midY - barHeight / 2)
        ctx.lineTo(x, midY + barHeight / 2)
      }
      ctx.stroke()
    }

    let rafId = 0
    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick)

      const second = Math.floor((now - startedAt) / MS_PER_SECOND)
      if (second !== lastDisplayedSecond) {
        lastDisplayedSecond = second
        setElapsedSeconds(second)
      }

      const sinceLastSample = now - lastSampleAt
      if (sinceLastSample >= CONSTANTS.RECORDING_WAVEFORM_SAMPLE_INTERVAL_MS) {
        let level = 0
        if (analyser && frame) {
          analyser.getByteTimeDomainData(frame)
          level = measureLevel(frame)
        }
        levels.push(level)
        const capacity = Math.ceil(cssWidth / step) + 1
        if (levels.length > capacity) {
          levels.splice(0, levels.length - capacity)
        }
        // Carry the remainder so the scroll speed stays steady even when a
        // frame lands late.
        lastSampleAt =
          now -
          (sinceLastSample % CONSTANTS.RECORDING_WAVEFORM_SAMPLE_INTERVAL_MS)
      }

      // Slide the strip continuously between samples so bars glide left
      // instead of jumping one slot at a time.
      const scrollOffset = reduceMotion
        ? 0
        : ((now - lastSampleAt) /
            CONSTANTS.RECORDING_WAVEFORM_SAMPLE_INTERVAL_MS) *
          step
      draw(scrollOffset)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      source?.disconnect()
      if (audioContext) {
        void audioContext.close().catch(() => {})
      }
    }
  }, [stream])

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3 text-content-secondary',
        className,
      )}
      style={style}
    >
      <span
        className="shrink-0 font-chat text-lg tabular-nums text-content-primary"
        data-testid="recording-timer"
      >
        {formatRecordingDuration(elapsedSeconds)}
      </span>
      <canvas
        ref={canvasRef}
        className="min-w-0 flex-1"
        style={{ height: `${CONSTANTS.RECORDING_WAVEFORM_HEIGHT_PX}px` }}
        aria-hidden="true"
      />
    </div>
  )
}
