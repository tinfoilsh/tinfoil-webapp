'use client'

import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { cn } from '../ui/utils'

interface DeleteConfirmationProps {
  onConfirm: () => void
  onCancel: () => void
  isDarkMode: boolean
  animated?: boolean
}

export function DeleteConfirmation({
  onConfirm,
  onCancel,
  isDarkMode,
  animated = true,
}: DeleteConfirmationProps) {
  const { t } = useTranslation('common')
  const content = (
    <>
      <button
        className={cn(
          'flex-1 rounded-md p-2 text-sm font-medium transition-colors',
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
        {t('cancel')}
      </button>
      <button
        className={cn(
          'flex-1 rounded-md p-2 text-sm font-medium transition-colors',
          isDarkMode
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-red-500 text-white hover:bg-red-600',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onConfirm()
        }}
      >
        {t('delete')}
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
        className="absolute inset-0 z-50 flex gap-2 rounded-md bg-surface-sidebar p-2 shadow-lg"
      >
        {content}
      </motion.div>
    )
  }

  return (
    <div className="absolute inset-0 z-50 flex gap-2 rounded-md bg-surface-sidebar p-2 shadow-lg">
      {content}
    </div>
  )
}
