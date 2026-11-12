'use client'

import { Logo } from '@/components/logo'
import { PrivacyLock } from '@/components/onboarding/privacy-lock'
import { motion, useReducedMotion } from 'framer-motion'
import { useId, useState, type CSSProperties } from 'react'

const OPEN_HOLD_S = 0.5
const ZOOM_OUT_DURATION_S = 0.35
const ZOOM_OUT_SCALE = 0.25
const RING_DASH_COUNT = 12
const RING_DASH_LENGTH = 0.7
const RING_STYLE: CSSProperties & {
  '--loading-ring-dash-count': number
  '--loading-ring-offset': string
} = {
  '--loading-ring-dash-count': RING_DASH_COUNT,
  '--loading-ring-offset': `${-RING_DASH_COUNT}px`,
}

function LockAnimation({
  isLoading,
  onFinished,
}: {
  isLoading: boolean
  onFinished?: () => void
}) {
  const [closed, setClosed] = useState(false)
  const reducedMotion = useReducedMotion()
  const maskId = useId()

  return (
    <motion.div
      className="relative flex h-16 w-16 items-center justify-center text-content-primary"
      initial="waiting"
      animate={!isLoading && closed ? 'finished' : 'waiting'}
      variants={{
        waiting: { scale: 1, opacity: 1 },
        finished: { scale: reducedMotion ? 1 : ZOOM_OUT_SCALE, opacity: 0 },
      }}
      transition={{
        duration: reducedMotion ? 0 : ZOOM_OUT_DURATION_S,
        ease: 'easeIn',
      }}
      onAnimationComplete={(definition) => {
        if (definition === 'finished' && !isLoading) onFinished?.()
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 64 64"
        className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
        fill="none"
        style={RING_STYLE}
      >
        {isLoading && (
          <defs>
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="64"
              height="64"
            >
              <rect width="64" height="64" fill="white" />
              <circle
                cx="32"
                cy="32"
                r="30"
                pathLength={RING_DASH_COUNT}
                stroke="black"
                strokeWidth="4"
                strokeDasharray={`${RING_DASH_LENGTH} ${RING_DASH_COUNT - RING_DASH_LENGTH}`}
                className={reducedMotion ? undefined : 'loading-lock-ring-gap'}
              />
            </mask>
          </defs>
        )}
        <circle
          cx="32"
          cy="32"
          r="30"
          pathLength={RING_DASH_COUNT}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={
            isLoading
              ? `${RING_DASH_LENGTH} ${1 - RING_DASH_LENGTH}`
              : undefined
          }
          mask={isLoading ? `url(#${maskId})` : undefined}
        />
      </svg>
      <PrivacyLock
        locked={!isLoading}
        startOpen={!reducedMotion}
        delay={OPEN_HOLD_S}
        onSettled={setClosed}
        className="h-8 w-8 text-content-primary"
      />
    </motion.div>
  )
}

export function LogoLoading({
  isLoading = true,
  onFinished,
}: {
  isLoading?: boolean
  onFinished?: () => void
}) {
  return (
    <div className="app-shell flex overflow-hidden bg-surface-chat-background">
      <div className="flex flex-1 items-center justify-center">
        <LockAnimation
          key={isLoading ? 'loading' : 'ready'}
          isLoading={isLoading}
          onFinished={onFinished}
        />
      </div>
      <div className="absolute inset-x-0 bottom-[max(2rem,env(safe-area-inset-bottom))] flex justify-center">
        <Logo className="h-5 w-auto dark:hidden" />
        <Logo dark className="hidden h-5 w-auto dark:block" />
      </div>
    </div>
  )
}
