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

function formatWindow(windowHours: number): string {
  if (windowHours % HOURS_PER_DAY === 0) {
    const days = windowHours / HOURS_PER_DAY
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  return `${windowHours} ${windowHours === 1 ? 'hour' : 'hours'}`
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
  const { flaggedChats, policy, status, isPreview } = useSafeguards()

  useEffect(() => {
    void refreshSafeguards()
  }, [])

  const windowDescription = policy ? formatWindow(policy.windowHours) : null
  const windowStart = policy ? Date.now() - policy.windowHours * MS_PER_HOUR : 0
  const inWindow = policy?.inWindow ?? 0
  const banThreshold = policy?.banThreshold ?? 0
  const progress =
    banThreshold > 0 ? Math.min(100, (inWindow / banThreshold) * 100) : 0
  const remaining = Math.max(0, banThreshold - inWindow)
  const nearLimit = policy ? inWindow >= policy.warnThreshold : false
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
        <div className={cn(cardClass, 'space-y-4 p-4 font-aeonik')}>
          <section className="space-y-1">
            <h4 className="text-sm font-semibold text-content-primary">
              Your conversations stay private
            </h4>
            <p className="text-sm leading-relaxed text-content-secondary">
              Safeguards run entirely inside secure enclaves. Tinfoil cannot
              read your conversations, and there is no human review of your
              private chats.
            </p>
          </section>
          <section className="space-y-1">
            <h4 className="text-sm font-semibold text-content-primary">
              Safeguards assess model responses
            </h4>
            <p className="text-sm leading-relaxed text-content-secondary">
              Automated checks assess model responses in conversational
              context—not user prompts for wrongdoing—against our narrow hard-no
              policy on child endangerment, mass violence and terrorism, and
              encouraging self-harm.
            </p>
          </section>
          <section className="space-y-1">
            <h4 className="text-sm font-semibold text-content-primary">
              Only a flag leaves the enclave
            </h4>
            <p className="text-sm leading-relaxed text-content-secondary">
              Only a flag linked to your account and chat ID leaves the
              enclaves—not the conversation or flagged category. Encrypted
              stored backups are not scanned; checks happen only at inference
              time.
            </p>
          </section>
          <a
            href={SAFEGUARDS_INFO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-brand-accent-dark hover:underline dark:text-brand-accent-light"
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

        {isPreview && (
          <p className="font-aeonik text-sm text-content-muted">
            Local preview only. These flags do not affect your account.
          </p>
        )}

        <div className={cn(cardClass, 'font-aeonik')}>
          <div className="space-y-2 border-b border-border-subtle p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-aeonik text-sm text-content-primary">
                {policy
                  ? `${inWindow} of ${banThreshold} flags in the last ${windowDescription}`
                  : status === 'error'
                    ? 'Flag count unavailable'
                    : 'Loading flag count…'}
              </span>
              {policy && (
                <span
                  className={cn(
                    'text-xs',
                    nearLimit ? 'text-red-600' : 'text-content-muted',
                  )}
                >
                  {remaining === 0
                    ? 'Suspension limit reached'
                    : `${remaining} more before account suspension`}
                </span>
              )}
            </div>
            <Progress
              value={policy ? progress : null}
              aria-label="Flags toward account suspension"
              aria-valuetext={
                policy
                  ? `${inWindow} of ${banThreshold} flags`
                  : status === 'error'
                    ? 'Unavailable'
                    : 'Loading'
              }
              className="h-2 bg-red-900/15 dark:bg-red-900/30 [&>div]:bg-red-800"
            />
          </div>
          {status === 'error' && (
            <div
              role="alert"
              className="space-y-2 px-4 py-3 text-sm text-content-muted"
            >
              <p>Could not load flagged chats. Please try again.</p>
              {policy && <p>Showing the last loaded flags.</p>}
              <button
                type="button"
                onClick={() => void refreshSafeguards()}
                className="text-brand-accent-dark hover:underline dark:text-brand-accent-light"
              >
                Try again
              </button>
            </div>
          )}
          {status === 'loading' && policy && (
            <p role="status" className="px-4 py-3 text-sm text-content-muted">
              Refreshing flagged chats…
            </p>
          )}
          {policy && inWindow === 0 && (
            <p className="px-4 py-3 text-sm text-content-muted">
              No flagged chats in the last {windowDescription}.
            </p>
          )}
          {policy && (
            <p className="px-4 py-3 text-xs text-content-muted">
              These flags identify chats containing model responses flagged by
              safeguards. Repeated flags within the counting window can lead to
              automatic account suspension.
              {` Flags count for ${windowDescription}; older flags no longer count toward suspension.`}
            </p>
          )}
          {policy && flaggedChats.length > 0 && (
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
          )}
        </div>
      </div>
    </>
  )
}
