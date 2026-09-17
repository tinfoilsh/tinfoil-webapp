'use client'

import { useSafeguards } from '@/hooks/use-safeguards'
import {
  SAFEGUARDS_INFO_URL,
  refreshSafeguards,
  type FlaggedChat,
} from '@/services/safeguards'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  FlagIcon,
} from '@heroicons/react/24/outline'
import Link from 'next/link'
import { useEffect } from 'react'
import { Progress } from '../ui/progress'
import { cn } from '../ui/utils'

const MS_PER_HOUR = 60 * 60 * 1000
const HOURS_PER_DAY = 24

interface SafeguardsSettingsProps {
  isDarkMode: boolean
  onNavigateToChat: () => void
}

function formatFlagDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function windowDays(windowHours: number): number {
  return Math.round(windowHours / HOURS_PER_DAY)
}

function FlaggedChatRow({
  flag,
  inWindow,
  onNavigate,
}: {
  flag: FlaggedChat
  inWindow: boolean
  onNavigate: () => void
}) {
  const label = flag.conversationId || 'Unknown chat'
  const content = (
    <>
      <FlagIcon
        className={cn(
          'h-4 w-4 flex-shrink-0',
          inWindow ? 'text-red-600' : 'text-content-muted',
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-aeonik-fono text-sm',
          inWindow ? 'text-content-primary' : 'text-content-muted',
        )}
      >
        {label}
      </span>
      <span className="flex-shrink-0 font-aeonik-fono text-xs text-content-muted">
        {formatFlagDate(flag.createdAt)}
      </span>
    </>
  )

  if (!flag.conversationId) {
    return <li className="flex items-center gap-3 px-4 py-2.5">{content}</li>
  }
  return (
    <li>
      <Link
        href={`/chat/${encodeURIComponent(flag.conversationId)}`}
        onClick={onNavigate}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-chat"
      >
        {content}
      </Link>
    </li>
  )
}

export function SafeguardsSettings({
  isDarkMode,
  onNavigateToChat,
}: SafeguardsSettingsProps) {
  const { flaggedChats, policy, status } = useSafeguards()

  useEffect(() => {
    void refreshSafeguards()
  }, [])

  const days = policy ? windowDays(policy.windowHours) : null
  const windowStart = policy ? Date.now() - policy.windowHours * MS_PER_HOUR : 0
  const inWindow = policy?.inWindow ?? 0
  const banThreshold = policy?.banThreshold ?? 0
  const progress =
    banThreshold > 0 ? Math.min(100, (inWindow / banThreshold) * 100) : 0
  const remaining = Math.max(0, banThreshold - inWindow)
  const nearBan = policy ? inWindow >= policy.warnThreshold : false
  const cardClass = cn(
    'rounded-lg border border-border-subtle',
    isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
  )

  return (
    <>
      <div className="space-y-3">
        <h3 className="font-aeonik text-sm font-medium text-content-secondary">
          Safeguards
        </h3>
        <div className={cn(cardClass, 'p-4')}>
          <p className="font-aeonik-fono text-sm text-content-secondary">
            Tinfoil runs automated safeguards inside the enclave to detect
            conversations that violate the acceptable use policy. Flagged chats
            count toward an account ban for {days} days; older flags stay on
            record but no longer count.
          </p>
          <a
            href={SAFEGUARDS_INFO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 font-aeonik text-sm text-brand-accent-dark hover:underline dark:text-brand-accent-light"
          >
            Learn how safeguards work
            <ArrowTopRightOnSquareIcon
              className="h-3.5 w-3.5"
              aria-hidden="true"
            />
          </a>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-aeonik text-sm font-medium text-content-secondary">
            Flagged Chats
          </h3>
          <button
            type="button"
            onClick={() => void refreshSafeguards()}
            disabled={status === 'loading'}
            aria-label="Refresh flagged chats"
            className="rounded-md p-1 text-content-muted transition-colors hover:text-content-primary disabled:opacity-50"
          >
            <ArrowPathIcon
              className={cn('h-4 w-4', status === 'loading' && 'animate-spin')}
              aria-hidden="true"
            />
          </button>
        </div>

        {status === 'error' && flaggedChats.length === 0 ? (
          <div className={cn(cardClass, 'p-4')}>
            <p className="font-aeonik-fono text-sm text-content-muted">
              Could not load flagged chats. Try again in a moment.
            </p>
          </div>
        ) : flaggedChats.length === 0 ? (
          <div className={cn(cardClass, 'p-4')}>
            <p className="font-aeonik-fono text-sm text-content-muted">
              {status === 'loading' || days === null
                ? 'Loading flagged chats...'
                : `No flagged chats in the last ${days} days.`}
            </p>
          </div>
        ) : (
          <div className={cardClass}>
            <div className="space-y-2 border-b border-border-subtle p-4">
              <div className="flex items-center justify-between">
                <span className="font-aeonik text-sm text-content-primary">
                  {inWindow} of {banThreshold} flags in the last {days} days
                </span>
                <span
                  className={cn(
                    'font-aeonik-fono text-xs',
                    nearBan ? 'text-red-600' : 'text-content-muted',
                  )}
                >
                  {remaining === 0
                    ? 'Ban threshold reached'
                    : `${remaining} more before account ban`}
                </span>
              </div>
              <Progress
                value={progress}
                aria-label="Flags toward account ban"
                className="h-2 bg-red-900/15 dark:bg-red-900/30 [&>div]:bg-red-800"
              />
            </div>
            <ul className="divide-y divide-border-subtle">
              {flaggedChats.map((flag) => (
                <FlaggedChatRow
                  key={flag.id}
                  flag={flag}
                  inWindow={flag.createdAt >= windowStart}
                  onNavigate={onNavigateToChat}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}
