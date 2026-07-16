'use client'

import { useSyncHealth } from '@/hooks/use-sync-health'
import type {
  SyncActionReason,
  SyncHealthSnapshot,
} from '@/services/cloud/sync-health'
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { cn } from '../ui/utils'
import { formatRelativeTime } from './chat-list-utils'

const ACTION_REASON_COPY: Record<
  SyncActionReason,
  { message: string; cta: string | null }
> = {
  'key-recovery': {
    message:
      'Sync is paused because your encryption key needs to be recovered.',
    cta: 'Recover Key',
  },
  'key-mismatch': {
    message:
      "This device's encryption key is out of date and needs to be recovered.",
    cta: 'Recover Key',
  },
  'key-conflict': {
    message:
      "Your cloud data is protected by a different key than this device's.",
    cta: 'Resolve',
  },
  'account-blocked': {
    message:
      'Sync is unavailable for this account. Please contact support if this persists.',
    cta: null,
  },
}

function describeStatus(health: SyncHealthSnapshot): {
  tone: 'ok' | 'warning' | 'error'
  headline: string
  detail: string | null
  cta: string | null
} {
  if (health.gate.kind === 'action-required') {
    const copy = ACTION_REASON_COPY[health.gate.reason]
    return {
      tone: 'error',
      headline: 'Action needed',
      detail: copy.message,
      cta: copy.cta,
    }
  }
  if (health.gate.kind === 'paused') {
    return {
      tone: 'warning',
      headline: 'Sync paused',
      detail:
        health.gate.reason === 'attestation'
          ? "The sync server couldn't be verified. Retrying automatically."
          : 'Having trouble reaching the cloud. Retrying automatically.',
      cta: null,
    }
  }
  // An open gate with terminally failed chats is not a success state;
  // a green "Synced" headline would contradict the failure list below.
  if (Object.keys(health.failedChats).length > 0) {
    return {
      tone: 'warning',
      headline: "Some chats aren't syncing",
      detail: health.lastSyncedAt
        ? `Last synced ${formatRelativeTime(new Date(health.lastSyncedAt))}`
        : null,
      cta: null,
    }
  }
  return {
    tone: 'ok',
    headline: health.lastSyncedAt
      ? `Synced ${formatRelativeTime(new Date(health.lastSyncedAt))}`
      : 'Sync is on',
    detail: null,
    cta: null,
  }
}

const MAX_FAILED_CHAT_DETAILS = 5

interface CloudSyncHealthCardProps {
  isDarkMode: boolean
  onRecoverClick?: () => void
  chats?: ReadonlyArray<{ id: string; title: string }>
}

/**
 * Status row for Settings > Cloud Sync, rendered from the sync-health
 * store. Quiet single line when everything works; explains the
 * problem and offers the recovery wizard when the key gate is closed;
 * lists how many chats are stuck when uploads fail terminally.
 */
export function CloudSyncHealthCard({
  isDarkMode,
  onRecoverClick,
  chats = [],
}: CloudSyncHealthCardProps) {
  const health = useSyncHealth()
  const status = describeStatus(health)
  const failedEntries = Object.entries(health.failedChats)
  const failedCount = failedEntries.length
  const chatTitle = (chatId: string) =>
    chats.find((chat) => chat.id === chatId)?.title ?? 'Untitled chat'

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        status.tone === 'error'
          ? 'border-orange-500/40'
          : 'border-border-subtle',
        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {status.tone === 'ok' ? (
            <CheckCircleIcon
              className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
              aria-hidden="true"
            />
          ) : status.tone === 'warning' ? (
            <ExclamationTriangleIcon
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
          ) : (
            <ExclamationCircleIcon
              className="mt-0.5 h-4 w-4 shrink-0 text-orange-500"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <div className="font-aeonik text-sm font-medium text-content-primary">
              {status.headline}
            </div>
            {status.detail && (
              <div className="mt-0.5 font-aeonik-fono text-xs text-content-muted">
                {status.detail}
              </div>
            )}
            {failedCount > 0 && (
              <div className="mt-0.5 font-aeonik-fono text-xs text-orange-500">
                {failedCount === 1
                  ? "1 chat couldn't be synced."
                  : `${failedCount} chats couldn't be synced.`}{' '}
                Affected chats are marked in the sidebar.
                <ul className="mt-1 space-y-0.5">
                  {failedEntries
                    .slice(0, MAX_FAILED_CHAT_DETAILS)
                    .map(([chatId, message]) => (
                      <li key={chatId} className="truncate">
                        <span className="font-medium">{chatTitle(chatId)}</span>
                        {': '}
                        {message}
                      </li>
                    ))}
                  {failedCount > MAX_FAILED_CHAT_DETAILS && (
                    <li>and {failedCount - MAX_FAILED_CHAT_DETAILS} more…</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>
        {status.cta && onRecoverClick && (
          <button
            type="button"
            onClick={onRecoverClick}
            className="shrink-0 rounded-md bg-orange-500/90 px-2.5 py-1.5 font-aeonik text-xs font-medium text-white transition-colors hover:bg-orange-500"
          >
            {status.cta}
          </button>
        )}
      </div>
    </div>
  )
}
