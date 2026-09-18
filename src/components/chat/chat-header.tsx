'use client'

import { useSyncFailedChats } from '@/hooks/use-sync-health'
import { CloudArrowUpIcon, CloudIcon } from '@heroicons/react/24/outline'
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { CiFloppyDisk } from 'react-icons/ci'
import { SlGhost } from 'react-icons/sl'
import { cn } from '../ui/utils'
import { formatRelativeTime } from './chat-list-utils'
import type { Chat } from './types'

const INITIAL_TURN_MESSAGE_COUNT = 2

interface ChatHeaderProps {
  chat: Chat
  isStreaming: boolean
  /** Action buttons rendered at the trailing edge of the header. */
  actions: React.ReactNode
  leadingAction?: React.ReactNode
  notice?: React.ReactNode
  className?: string
}

type SyncStatus =
  | { kind: 'temporary' }
  | { kind: 'local' }
  | { kind: 'failed' }
  | { kind: 'syncing' }
  | { kind: 'synced' }
  | null

function resolveSyncStatus(
  chat: Chat,
  isStreaming: boolean,
  syncFailed: boolean,
): SyncStatus {
  if (chat.isTemporary) return { kind: 'temporary' }
  if (chat.isLocalOnly) return { kind: 'local' }
  if (syncFailed) return { kind: 'failed' }
  if (chat.pendingSave || chat.locallyModified)
    return isStreaming ? null : { kind: 'syncing' }
  if (chat.syncedAt != null) return { kind: 'synced' }
  return null
}

const toDate = (value?: Date | string): Date | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function ChatHeader({
  chat,
  isStreaming,
  actions,
  leadingAction,
  notice,
  className,
}: ChatHeaderProps) {
  const syncFailedChats = useSyncFailedChats()
  const syncStatus = resolveSyncStatus(
    chat,
    isStreaming,
    Boolean(syncFailedChats[chat.id]),
  )

  const createdAt = toDate(chat.createdAt)
  const updatedAt = toDate(chat.updatedAt) ?? createdAt
  const referenceTime = Date.now()
  const createdRelativeTime = createdAt
    ? formatRelativeTime(createdAt, referenceTime)
    : null
  const updatedRelativeTime = updatedAt
    ? formatRelativeTime(updatedAt, referenceTime)
    : null
  const messageCount = chat.isMetadataOnly
    ? (chat.messageCount ?? 0)
    : chat.messages.length
  // The first turn creates the chat, so its saves are not meaningful
  // updates. Later turns show the updated time once streaming settles and
  // only when it reads differently from the creation time.
  const showUpdatedTime =
    !isStreaming &&
    messageCount > INITIAL_TURN_MESSAGE_COUNT &&
    updatedRelativeTime !== null &&
    updatedRelativeTime !== createdRelativeTime

  const metaItems: React.ReactNode[] = []
  if (createdRelativeTime) {
    metaItems.push(<span key="created">{createdRelativeTime}</span>)
  }
  if (showUpdatedTime) {
    metaItems.push(<span key="updated">Updated {updatedRelativeTime}</span>)
  }
  if (syncStatus) {
    metaItems.push(
      <span key="sync" className="flex items-center gap-1">
        {syncStatus.kind === 'temporary' ? (
          <span className="flex items-center gap-1 text-orange-500">
            <SlGhost className="h-3 w-3" aria-hidden="true" />
            Temporary chat
          </span>
        ) : syncStatus.kind === 'local' ? (
          <>
            <CiFloppyDisk className="h-3.5 w-3.5" aria-hidden="true" />
            Only saved locally
          </>
        ) : syncStatus.kind === 'failed' ? (
          <span className="flex items-center gap-1 text-orange-500">
            <ExclamationTriangleIcon className="h-3 w-3" aria-hidden="true" />
            Couldn&apos;t sync
          </span>
        ) : syncStatus.kind === 'syncing' ? (
          <span className="flex items-center gap-1 text-blue-500">
            <CloudArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Syncing
          </span>
        ) : (
          <>
            <CloudIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Synced
          </>
        )}
      </span>,
    )
  }

  return (
    <header
      className={cn(
        'grid flex-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-subtle bg-surface-chat-background px-4 py-2.5 @3xl/conversation:gap-4 @3xl/conversation:px-6',
        notice &&
          '@3xl/conversation:grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 @3xl/conversation:gap-4">
        {leadingAction && (
          <div className="flex flex-none items-center">{leadingAction}</div>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className="truncate font-aeonik text-sm font-medium text-content-primary"
            title={chat.title}
          >
            {chat.title}
          </h1>
          {metaItems.length > 0 && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-aeonik-fono text-xs leading-none text-content-muted">
              {metaItems.map((item, index) => (
                <span
                  key={index}
                  className="flex flex-none items-center gap-1.5"
                >
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {item}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      {notice && (
        <div
          data-chat-header-notice
          className="-mt-2.5 hidden self-start @3xl/conversation:flex"
        >
          {notice}
        </div>
      )}
      <div className="flex flex-none items-center justify-end gap-2">
        {actions}
      </div>
    </header>
  )
}
