import { motion } from 'framer-motion'
import { PiSpinner } from 'react-icons/pi'
import { CONSTANTS } from './constants'

interface ForkOverlayProps {
  /** Which side the chat sidebar is on; the conversation lifts toward it. */
  sidebarSide: 'left' | 'right'
}

/**
 * Covers the conversation while a fork is in progress. The transcript
 * behind it is dimmed and a ghost copy lifts out toward the sidebar, so
 * the user sees their conversation "leave" for the new chat before the
 * fork has actually landed in storage.
 */
export function ForkOverlay({ sidebarSide }: ForkOverlayProps) {
  const liftX = sidebarSide === 'left' ? '-40%' : '40%'
  return (
    <motion.div
      className="absolute inset-0 z-20 flex items-center justify-center bg-surface-chat-background/70 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      role="status"
      aria-live="polite"
      aria-label="Forking conversation"
    >
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[15%] inset-y-[10%] rounded-2xl border border-border-subtle bg-surface-chat-background shadow-xl"
        initial={{ opacity: 0.9, scale: 1, x: 0, y: 0 }}
        animate={{ opacity: 0, scale: 0.35, x: liftX, y: '-30%' }}
        transition={{
          duration: CONSTANTS.FORK_LIFT_DURATION_S,
          ease: [0.4, 0, 0.2, 1],
        }}
      />
      <div className="relative flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-chat-background px-5 py-3 text-content-primary shadow-lg">
        <PiSpinner className="h-5 w-5 animate-spin text-content-secondary" />
        <span className="text-sm font-medium">Forking conversation...</span>
      </div>
    </motion.div>
  )
}
