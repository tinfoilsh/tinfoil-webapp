'use client'

import type { StreamErrorInfo } from '@/components/chat/hooks/use-chat-streams'
import { cn } from '@/components/ui/utils'
import {
  ArrowPathIcon,
  ChevronDownIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useState, useSyncExternalStore } from 'react'

interface StreamErrorBannerProps {
  error: StreamErrorInfo
  onDismiss: () => void
  onRetry?: () => void
  isDarkMode: boolean
}

// Behavioral class of a stream failure. Drives both the explanation copy
// and the retry affordance so the same error always produces a coherent
// combination of message and action.
type ErrorKind =
  | 'connection'
  | 'rate-limit'
  | 'timeout'
  | 'context-length'
  | 'server'
  | 'unknown'

type ErrorClassification = {
  kind: ErrorKind
  title: string
  suggestion: string
}

function subscribeToConnectivity(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function getIsOnline(): boolean {
  return navigator.onLine !== false
}

/** Live `navigator.onLine` mirror; updates as connectivity changes. */
function useIsOnline(): boolean {
  return useSyncExternalStore(subscribeToConnectivity, getIsOnline, () => true)
}

const CLASSIFICATIONS: Record<
  Exclude<ErrorKind, 'unknown'>,
  ErrorClassification
> = {
  connection: {
    kind: 'connection',
    title: 'Connection problem',
    suggestion:
      'Check your internet connection, then resend your message. Your message was not lost.',
  },
  'rate-limit': {
    kind: 'rate-limit',
    title: 'Usage limit reached',
    suggestion: 'Please wait for the limit to reset before trying again.',
  },
  timeout: {
    kind: 'timeout',
    title: 'The model took too long to respond',
    suggestion:
      'This is usually a temporary problem on our side. Please try again in a moment.',
  },
  'context-length': {
    kind: 'context-length',
    title: 'This conversation is too long for the model',
    suggestion:
      'Remove an attachment, shorten your message, or switch to a model with a larger context window.',
  },
  server: {
    kind: 'server',
    title: 'The service is having trouble right now',
    suggestion:
      'Our servers may be briefly overloaded. Please try again, or switch to a different model.',
  },
}

// Map a stream failure to a behavioral kind plus human-readable copy. The
// structured code is authoritative when present; the message-text
// heuristics below are display-only fallbacks for errors that carry no
// classification, and both the copy and the retry affordance derive from
// the same result so they can never disagree. The raw message stays
// available in the expandable details section.
function classifyError({
  message,
  code,
}: StreamErrorInfo): ErrorClassification {
  if (code === 'FETCH_ERROR') return CLASSIFICATIONS.connection
  if (code === 'RATE_LIMIT' || code === 'HOURLY_LIMIT') {
    return CLASSIFICATIONS['rate-limit']
  }
  if (code === 'SERVER_ERROR') return CLASSIFICATIONS.server

  const lower = message.toLowerCase()

  if (
    lower.includes('context deadline exceeded') ||
    lower.includes('client.timeout') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout')
  ) {
    return CLASSIFICATIONS.timeout
  }

  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens') ||
    lower.includes('token limit') ||
    lower.includes('input is too long')
  ) {
    return CLASSIFICATIONS['context-length']
  }

  if (
    lower.includes('overloaded') ||
    lower.includes('capacity') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('internal server error') ||
    /\b5\d\d\b/.test(lower)
  ) {
    return CLASSIFICATIONS.server
  }

  if (
    lower.includes('network') ||
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('connection') ||
    lower.includes('econnreset') ||
    lower.includes('offline')
  ) {
    return CLASSIFICATIONS.connection
  }

  return {
    kind: 'unknown',
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
  error,
  onDismiss,
  onRetry,
  isDarkMode,
}: StreamErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const isOnline = useIsOnline()
  const { kind, title, suggestion } = classifyError(error)

  // Retrying always re-sends the last message; make the label say so for
  // connection failures instead of the ambiguous "Try again" (which reads
  // like it might just reconnect). While offline the resend is gated —
  // it would only burn the automatic in-request retries and fail again.
  const isConnectionError = kind === 'connection'
  // A rate-limited request will fail identically until the limit resets,
  // so a retry button is just an invitation to frustration.
  const isLimitError = kind === 'rate-limit'
  const retryLabel = isConnectionError ? 'Resend message' : 'Try again'
  const retryDisabled = isConnectionError && !isOnline
  const showRetry = !!onRetry && !isLimitError

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
      <div className="flex gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
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
          {showRetry && (
            <button
              type="button"
              disabled={retryDisabled}
              title={retryDisabled ? 'Waiting for connection...' : undefined}
              onClick={(e) => {
                e.stopPropagation()
                onRetry?.()
              }}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-site-control border px-3 text-xs font-medium transition-colors sm:self-center',
                isDarkMode
                  ? 'border-red-500/40 hover:bg-red-500/20'
                  : 'border-red-300 hover:bg-red-500/10',
                retryDisabled &&
                  'cursor-default opacity-50 hover:bg-transparent',
              )}
            >
              <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {retryDisabled ? 'Offline' : retryLabel}
            </button>
          )}
        </div>
        <div className="flex shrink-0 flex-col justify-between gap-1">
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
        </div>
      </div>
      {isExpanded && (
        <div
          className={cn(
            'border-t px-3 py-2 text-xs',
            isDarkMode ? 'border-red-500/30' : 'border-red-300',
          )}
        >
          <p className="whitespace-pre-wrap break-words">{error.message}</p>
        </div>
      )}
    </div>
  )
}
