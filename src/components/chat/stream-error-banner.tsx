'use client'

import { cn } from '@/components/ui/utils'
import {
  ArrowPathIcon,
  ChevronDownIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'

interface StreamErrorBannerProps {
  message: string
  onDismiss: () => void
  onRetry?: () => void
  isDarkMode: boolean
}

type ErrorExplanation = {
  title: string
  suggestion: string
}

// Map raw backend/SDK error text to a human-readable explanation. The raw
// message stays available in the expandable details section.
function explainError(message: string): ErrorExplanation {
  const lower = message.toLowerCase()

  if (
    lower.includes('context deadline exceeded') ||
    lower.includes('client.timeout') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout')
  ) {
    return {
      title: 'The model took too long to respond',
      suggestion:
        'This is usually a temporary problem on our side. Please try again in a moment.',
    }
  }

  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens') ||
    lower.includes('token limit') ||
    lower.includes('input is too long')
  ) {
    return {
      title: 'This conversation is too long for the model',
      suggestion:
        'Remove an attachment, shorten your message, or switch to a model with a larger context window.',
    }
  }

  if (
    lower.includes('overloaded') ||
    lower.includes('capacity') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('internal server error') ||
    /\b5\d\d\b/.test(lower)
  ) {
    return {
      title: 'The service is having trouble right now',
      suggestion:
        'Our servers may be briefly overloaded. Please try again, or switch to a different model.',
    }
  }

  if (
    lower.includes('network') ||
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('connection') ||
    lower.includes('econnreset') ||
    lower.includes('offline')
  ) {
    return {
      title: 'Connection problem',
      suggestion: 'Check your internet connection and try again.',
    }
  }

  return {
    title: 'Something went wrong',
    suggestion: 'Please try again. If the problem persists, contact support.',
  }
}

/**
 * Inline error notice rendered directly above the chat input. Shows a
 * friendly summary with a retry action; the raw error is available in an
 * expandable details section. Stays visible until dismissed or retried.
 */
export function StreamErrorBanner({
  message,
  onDismiss,
  onRetry,
  isDarkMode,
}: StreamErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { title, suggestion } = explainError(message)

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDismiss()
  }

  return (
    <div
      role="alert"
      className={cn(
        'mb-2 overflow-hidden rounded-2xl border shadow-sm transition-colors',
        isDarkMode
          ? 'border-red-500/40 bg-red-950/60 text-red-200'
          : 'border-red-300 bg-red-50 text-red-700',
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p
            className={cn(
              'mt-0.5 text-xs',
              isDarkMode ? 'text-red-200/80' : 'text-red-700/80',
            )}
          >
            {suggestion}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {onRetry && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRetry()
              }}
              className={cn(
                'flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors',
                isDarkMode
                  ? 'border-red-500/40 hover:bg-red-500/20'
                  : 'border-red-300 hover:bg-red-500/10',
              )}
            >
              <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} error details`}
            className={cn(
              'rounded p-1 transition-colors',
              isDarkMode ? 'hover:bg-red-500/20' : 'hover:bg-red-500/10',
            )}
          >
            <ChevronDownIcon
              className={cn(
                'h-4 w-4 transition-transform',
                isExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
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
      </div>
      {isExpanded && (
        <div
          className={cn(
            'border-t px-3 py-2 text-xs',
            isDarkMode ? 'border-red-500/30' : 'border-red-300',
          )}
        >
          <p className="whitespace-pre-wrap break-words">{message}</p>
        </div>
      )}
    </div>
  )
}
