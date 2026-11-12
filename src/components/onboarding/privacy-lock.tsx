import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import { useEffect } from 'react'
import { LOCK_FRAMES, LOCK_FRAMES_VIEW_BOX } from './lock-frames'

const LOCKED_FRAME = LOCK_FRAMES.length - 1
// The time the animated lock icons in @tinfoilsh/tinfoil-icons take to step
// through every frame.
const LOCK_SWING_S = 0.6
const DEFAULT_LOCK_SIZE = 24

// A lock that swings shut when `locked` turns on and open again when it turns
// off, from wherever it is. With `startOpen`, a lock that appears locked
// swings shut as it appears.
export function PrivacyLock({
  locked,
  startOpen = false,
  delay = 0,
  duration = LOCK_SWING_S,
  onSettled,
  className,
  size = DEFAULT_LOCK_SIZE,
}: {
  locked: boolean
  startOpen?: boolean
  delay?: number
  duration?: number
  onSettled?: (locked: boolean) => void
  className?: string
  size?: number
}) {
  const frame = useMotionValue(locked && !startOpen ? LOCKED_FRAME : 0)
  const path = useTransform(frame, (value) => LOCK_FRAMES[Math.round(value)])
  const prefersReducedMotion = useReducedMotion()

  useEffect(() => {
    const target = locked ? LOCKED_FRAME : 0
    if (prefersReducedMotion) {
      frame.set(target)
      onSettled?.(locked)
      return
    }
    const remaining = Math.abs(target - frame.get()) / LOCKED_FRAME
    const controls = animate(frame, target, {
      duration: duration * remaining,
      delay: locked ? delay : 0,
      ease: 'linear',
      onComplete: () => onSettled?.(locked),
    })
    return () => controls.stop()
  }, [frame, locked, prefersReducedMotion, delay, duration, onSettled])

  return (
    <svg
      viewBox={LOCK_FRAMES_VIEW_BOX}
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <motion.path d={path} />
    </svg>
  )
}
