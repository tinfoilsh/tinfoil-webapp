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

// A lock that swings shut when `locked` turns on and open again when it turns
// off, from wherever it is.
export function PrivacyLock({
  locked,
  className,
}: {
  locked: boolean
  className?: string
}) {
  const frame = useMotionValue(locked ? LOCKED_FRAME : 0)
  const path = useTransform(frame, (value) => LOCK_FRAMES[Math.round(value)])
  const prefersReducedMotion = useReducedMotion()

  useEffect(() => {
    const target = locked ? LOCKED_FRAME : 0
    if (prefersReducedMotion) {
      frame.set(target)
      return
    }
    const remaining = Math.abs(target - frame.get()) / LOCKED_FRAME
    const controls = animate(frame, target, {
      duration: LOCK_SWING_S * remaining,
      ease: 'linear',
    })
    return () => controls.stop()
  }, [frame, locked, prefersReducedMotion])

  return (
    <svg
      viewBox={LOCK_FRAMES_VIEW_BOX}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <motion.path d={path} />
    </svg>
  )
}
