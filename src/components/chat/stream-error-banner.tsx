'use client'

import { cn } from '@/components/ui/utils'
import { REQUEST_UPGRADE_EVENT } from '@/constants/chat-events'
import { TfBoxX, TfChevronDown, TfRefresh1 } from '@tinfoilsh/tinfoil-icons'
import { useEffect, useState, useSyncExternalStore } from 'react'

export type StreamErrorInfo = {
  message: string
  code?: string
  // For an exhausted quota: which one (hourly or free_daily), and when it
  // resets.
  kind?: string
  resetsAt?: string
  // Seconds the harness asks the client to wait before retrying.
  retryAfter?: number
  // A document conversion failure's document_* code.
  upstreamCode?: string
  // When the error happened; a retry wait counts from then.
  timestamp?: number
}

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
  | 'auth'
  | 'rate-limit'
  | 'busy'
  | 'context-length'
  | 'too-large'
  | 'model'
  | 'document'
  | 'server'

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

const CLASSIFICATIONS: Record<ErrorKind, ErrorClassification> = {
  auth: {
    kind: 'auth',
    title: 'Unable to confirm your sign-in',
    suggestion:
      'Sign in again, then resend your message. Your message was not lost.',
  },
  connection: {
    kind: 'connection',
    title: 'Connection problem',
    suggestion:
      'Check your internet connection, then reconnect to the conversation.',
  },
  'rate-limit': {
    kind: 'rate-limit',
    title: 'Usage limit reached',
    suggestion: 'Please wait for the limit to reset before trying again.',
  },
  busy: {
    kind: 'busy',
    title: 'Too many requests right now',
    suggestion:
      'Wait a moment, then resend your message. Your message was not lost.',
  },
  'too-large': {
    kind: 'too-large',
    title: 'This chat is too large to save',
    suggestion:
      'Start a new chat, or fork this one from an earlier message to continue with less history.',
  },
  model: {
    kind: 'model',
    title: 'This model is unavailable right now',
    suggestion: 'Switch to another model, or try again in a moment.',
  },
  document: {
    kind: 'document',
    title: 'A document could not be processed',
    suggestion: 'Try again, or remove the document and resend your message.',
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

// Map a run failure to a behavioral kind plus human-readable copy using the
// chat service's structured error code. Unclassified failures (an interrupted
// stream, a transport error) are treated as connection problems. Both the copy
// and the retry affordance derive from the same result so they can never
// disagree. The raw message stays available in the expandable details section.
function formatResetTime(error: StreamErrorInfo): string | null {
  const at = error.resetsAt
    ? Date.parse(error.resetsAt)
    : error.retryAfter
      ? (error.timestamp ?? Date.now()) + error.retryAfter * 1000
      : NaN
  if (Number.isNaN(at)) return null
  return new Date(at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function quotaClassification(error: StreamErrorInfo): ErrorClassification {
  const resetLabel = formatResetTime(error)
  if (error.kind === 'hourly')
    return {
      kind: 'rate-limit',
      title: 'Hourly usage limit reached',
      suggestion: resetLabel
        ? `Your limit resets at ${resetLabel}. Your message was not lost.`
        : 'Please wait for the limit to reset before trying again.',
    }
  if (error.kind === 'free_daily')
    return {
      kind: 'rate-limit',
      title: 'Daily limit reached',
      suggestion: `Upgrade to Premium to keep chatting${resetLabel ? `, or try again after ${resetLabel}` : ''}.`,
    }
  return CLASSIFICATIONS['rate-limit']
}

function classifyError(error: StreamErrorInfo): ErrorClassification {
  // A document conversion failure carries the document service's fixed
  // explanation, which describes nothing in the file.
  if (error.upstreamCode?.startsWith('document_'))
    return error.code === 'RATE_LIMITED'
      ? {
          ...CLASSIFICATIONS.busy,
          title: 'The document service is busy',
        }
      : { ...CLASSIFICATIONS.document, suggestion: error.message }
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return CLASSIFICATIONS.auth
    case 'QUOTA_EXHAUSTED':
      return quotaClassification(error)
    case 'RATE_LIMITED':
      return CLASSIFICATIONS.busy
    case 'CONTEXT_TOO_LARGE':
      return CLASSIFICATIONS['context-length']
    case 'THREAD_TOO_LARGE':
      return CLASSIFICATIONS['too-large']
    case 'MODEL_UNAVAILABLE':
      return CLASSIFICATIONS.model
    case 'UPSTREAM_REFUSED':
    case 'TOOL_UNAVAILABLE':
    case 'MAX_TURNS':
      return CLASSIFICATIONS.server
    default:
      return CLASSIFICATIONS.connection
  }
}

// Counts down to the moment a retry is allowed, then stops.
function useSecondsUntil(at: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!at) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      const current = Date.now()
      setNow(current)
      if (at > current) timer = setTimeout(tick, Math.min(1000, at - current))
    }
    tick()
    return () => clearTimeout(timer)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0
}

export function StreamErrorBanner({
  error,
  onDismiss,
  onRetry,
  isDarkMode,
}: StreamErrorBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const isOnline = useIsOnline()
  const { kind, title, suggestion } = classifyError(error)
  const [shownAt] = useState(Date.now)
  // A busy service names how long to wait; resending is allowed once the
  // wait has passed.
  const waitSeconds = useSecondsUntil(
    kind === 'busy' && error.retryAfter
      ? (error.timestamp || shownAt) + error.retryAfter * 1000
      : 0,
  )

  // Retrying always re-sends the last message; make the label say so for
  // connection failures instead of the ambiguous "Try again" (which reads
  // like it might just reconnect). While offline the resend is gated —
  // it would only burn the automatic in-request retries and fail again.
  const isConnectionError = kind === 'connection'
  const isResend = isConnectionError || kind === 'busy'
  // A request refused for an exhausted quota or the chat's size fails
  // identically until that changes, so a retry button is just an invitation
  // to frustration.
  const showRetry = !!onRetry && kind !== 'rate-limit' && kind !== 'too-large'
  const isOffline = isResend && !isOnline
  const retryDisabled = isOffline || waitSeconds > 0
  const retryLabel = isOffline
    ? 'Offline'
    : waitSeconds > 0
      ? `Resend in ${waitSeconds}s`
      : isResend
        ? 'Resend message'
        : 'Try again'
  const showUpgrade = kind === 'rate-limit' && error.kind === 'free_daily'

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
              title={isOffline ? 'Waiting for connection...' : undefined}
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
              <TfRefresh1 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryLabel}
            </button>
          )}
          {showUpgrade && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                window.dispatchEvent(new CustomEvent(REQUEST_UPGRADE_EVENT))
              }}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-site-control border px-3 text-xs font-medium transition-colors sm:self-center',
                isDarkMode
                  ? 'border-red-500/40 hover:bg-red-500/20'
                  : 'border-red-300 hover:bg-red-500/10',
              )}
            >
              Upgrade to Premium
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
            <TfBoxX className="h-4 w-4" aria-hidden="true" />
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
            <TfChevronDown
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
