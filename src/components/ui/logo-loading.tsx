'use client'

import { Logo } from '@/components/logo'
import { PrivacyLock } from '@/components/onboarding/privacy-lock'
import { motion, useReducedMotion } from 'framer-motion'
import { useState } from 'react'

const OPEN_HOLD_S = 0.5
const ZOOM_OUT_DURATION_S = 0.35
const ZOOM_OUT_SCALE = 0.25

function LockAnimation({
  isLoading,
  onFinished,
}: {
  isLoading: boolean
  onFinished?: () => void
}) {
  const [closed, setClosed] = useState(false)
  const reducedMotion = useReducedMotion()

  return (
    <motion.div
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
