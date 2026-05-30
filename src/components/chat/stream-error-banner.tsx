'use client'

import { cn } from '@/components/ui/utils'
import { ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'

interface StreamErrorBannerProps {
  message: string
  onDismiss: () => void
  isDarkMode: boolean
}

const DEFAULT_ERROR_TITLE = 'Something went wrong'

// Extract a short, human-friendly title from the raw error message while
// keeping the full text available for the expanded view.
function getErrorTitle(message: string): string {
  const cleaned = message.replace(/^Error:\s*/i, '').trim()
  if (!cleaned) return DEFAULT_ERROR_TITLE
  const firstLine = cleaned.split('\n')[0]
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0]
  return firstSentence.length > 120
    ? `${firstSentence.slice(0, 117)}...`
    : firstSentence
}

export function StreamErrorBanner({
  message,
  onDismiss,
  isDarkMode,
}: StreamErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const title = getErrorTitle(message)

  const toggleExpanded = () => setIsExpanded((prev) => !prev)

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDismiss()
  }

  return (
    <div
      role="alert"
      className="pointer-events-none absolute left-0 right-0 top-2 z-10 flex w-full justify-center px-4"
    >
      <div
        className={cn(
          'pointer-events-auto w-full max-w-xl cursor-pointer overflow-hidden rounded-lg border shadow-lg backdrop-blur-sm transition-colors',
          isDarkMode
            ? 'border-red-500/40 bg-red-950/60 text-red-200'
            : 'border-red-300 bg-red-50 text-red-700',
        )}
        role="button"
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleExpanded()
          }
        }}
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={
          isExpanded ? 'Collapse error details' : 'Expand error details'
        }
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <ChevronDownIcon
            className={cn(
              'h-4 w-4 flex-shrink-0 transition-transform',
              isExpanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
          <span className="flex-1 truncate text-sm font-semibold">{title}</span>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss error"
            className={cn(
              'rounded p-1 transition-colors',
              isDarkMode ? 'hover:bg-red-500/20' : 'hover:bg-red-500/10',
            )}
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {isExpanded && (
          <div
            className={cn(
              'border-t px-3 py-2 text-sm',
              isDarkMode ? 'border-red-500/30' : 'border-red-300',
            )}
          >
            <p className="whitespace-pre-wrap break-words">{message}</p>
          </div>
        )}
      </div>
    </div>
  )
}
