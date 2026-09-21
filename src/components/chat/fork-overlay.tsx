import { motion } from 'framer-motion'
import { PiSpinner } from 'react-icons/pi'

/**
 * Covers the conversation while a fork is in progress so the transcript
 * behind it reads as busy until the fork has landed in storage.
 */
export function ForkOverlay() {
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
      <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-chat-background px-5 py-3 text-content-primary shadow-lg">
        <PiSpinner className="h-5 w-5 animate-spin text-content-secondary" />
        <span className="text-sm font-medium">Forking conversation...</span>
      </div>
    </motion.div>
  )
}
