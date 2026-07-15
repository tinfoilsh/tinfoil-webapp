import {
  getSignoutProgressState,
  subscribeToSignoutProgress,
  type SignoutStep,
} from '@/utils/signout-progress'
import { CheckIcon } from '@heroicons/react/24/outline'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function SignoutProgressOverlay() {
  const [state, setState] = useState(getSignoutProgressState)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubscribe = subscribeToSignoutProgress(setState)
    // Re-read after subscribing so updates emitted between the initial
    // render and this effect are not missed.
    setState(getSignoutProgressState())
    return unsubscribe
  }, [])

  // The overlay only blocks pointer interaction visually; also make the
  // rest of the app inert so keyboard users cannot activate background
  // controls while destructive cleanup runs.
  useEffect(() => {
    if (!state.visible) return
    const overlay = overlayRef.current
    const inerted: Element[] = []
    for (const el of Array.from(document.body.children)) {
      if (overlay && el.contains(overlay)) continue
      if (el.hasAttribute('inert')) continue
      el.setAttribute('inert', '')
      inerted.push(el)
    }
    return () => {
      for (const el of inerted) el.removeAttribute('inert')
    }
  }, [state.visible])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {state.visible && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-chat-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-6">
            <h2 className="text-lg font-semibold text-content-primary">
              Signing out
            </h2>
            <div className="flex flex-col gap-2">
              {state.steps.map((step, i) => (
                <StepRow key={i} step={step} index={i} />
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function StepRow({ step, index }: { step: SignoutStep; index: number }) {
  const prefersReducedMotion = useReducedMotion()

  return (
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, x: prefersReducedMotion ? 0 : -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1, duration: 0.2 }}
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {step.status === 'done' ? (
          <CheckIcon className="h-4 w-4 text-content-primary" />
        ) : step.status === 'active' ? (
          prefersReducedMotion ? (
            <span className="h-2 w-2 rounded-full bg-content-primary" />
          ) : (
            <motion.span
              className="h-2 w-2 rounded-full bg-content-primary"
              animate={{ scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1, repeat: Infinity }}
            />
          )
        ) : (
          <span className="h-2 w-2 rounded-full bg-border-subtle" />
        )}
      </span>
      <span
        className={`text-sm transition-colors ${
          step.status === 'pending'
            ? 'text-content-muted'
            : 'text-content-primary'
        }`}
      >
        {step.label}
      </span>
    </motion.div>
  )
}
