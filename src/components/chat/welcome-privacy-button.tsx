import { motion, useReducedMotion } from 'framer-motion'
import { useCallback, useState } from 'react'
import { TypingAnimation } from './typing-animation'

export const WELCOME_PRIVACY_LABEL = 'Your chats are private'
const BORDER_DRAW_DURATION_S = 0.6

export function WelcomePrivacyButton({ onClick }: { onClick: () => void }) {
  const [typed, setTyped] = useState(false)
  const reducedMotion = useReducedMotion()
  const drawBorder = reducedMotion || typed
  const finishTyping = useCallback(() => setTyped(true), [])

  return (
    <button
      type="button"
      aria-label={WELCOME_PRIVACY_LABEL}
      aria-haspopup="dialog"
      onClick={onClick}
      className="relative inline-flex items-center rounded-lg border border-transparent bg-surface-chat-background px-3 py-1.5 text-sm text-content-secondary transition-colors hover:bg-surface-chat hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-chat-background"
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-border-subtle"
        opacity={drawBorder ? 1 : 0}
      >
        <motion.rect
          width="100%"
          height="100%"
          className="[rx:var(--radius)]"
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          initial={reducedMotion ? false : 'hidden'}
          animate={drawBorder ? 'drawn' : 'hidden'}
          variants={{ hidden: { pathLength: 0 }, drawn: { pathLength: 1 } }}
          transition={{
            duration: reducedMotion ? 0 : BORDER_DRAW_DURATION_S,
            ease: 'easeInOut',
          }}
        />
      </svg>
      <span aria-hidden="true" className="relative whitespace-nowrap">
        <span className="invisible">{WELCOME_PRIVACY_LABEL}</span>
        <span className="absolute inset-0">
          {drawBorder ? (
            WELCOME_PRIVACY_LABEL
          ) : (
            <TypingAnimation
              fromText=""
              toText={WELCOME_PRIVACY_LABEL}
              onComplete={finishTyping}
            />
          )}
        </span>
      </span>
    </button>
  )
}
