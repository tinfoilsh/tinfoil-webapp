'use client'

import { motion } from 'framer-motion'
import { cn } from '../ui/utils'

interface DeleteConfirmationProps {
  onConfirm: () => void
  onCancel: () => void
  isDarkMode: boolean
  animated?: boolean
}

// The overlay is pinned to the row it covers (inset-0), so its height is
// whatever the row happens to be. Buttons therefore stretch to fill and center
// their label with flexbox instead of relying on vertical padding, which would
// overflow and push the text off-center whenever the row is shorter than the
// padded content.
const OVERLAY_CLASS_NAME =
  'absolute inset-0 z-50 flex items-stretch gap-1.5 rounded-lg bg-surface-sidebar p-1 shadow-lg'
const BUTTON_CLASS_NAME =
  'flex min-w-0 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium leading-none transition-colors'

export function DeleteConfirmation({
  onConfirm,
  onCancel,
  isDarkMode,
  animated = true,
}: DeleteConfirmationProps) {
  const content = (
    <>
      <button
        className={cn(
          BUTTON_CLASS_NAME,
          isDarkMode
            ? 'bg-surface-chat text-content-primary hover:bg-surface-chat/80'
            : 'bg-surface-chat text-content-secondary hover:bg-surface-chat/80',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onCancel()
        }}
        autoFocus
      >
        Cancel
      </button>
      <button
        className={cn(
          BUTTON_CLASS_NAME,
          isDarkMode
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-red-500 text-white hover:bg-red-600',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onConfirm()
        }}
      >
        Delete
      </button>
    </>
  )

  if (animated) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{
          opacity: 1,
          y: 0,
          transition: {
            duration: 0.2,
            ease: 'easeOut',
          },
        }}
        exit={{
          opacity: 0,
          transition: {
            duration: 0.15,
          },
        }}
        className={OVERLAY_CLASS_NAME}
      >
        {content}
      </motion.div>
    )
  }

  return <div className={OVERLAY_CLASS_NAME}>{content}</div>
}
