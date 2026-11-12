'use client'

import { TfCloud, TfFloppyDisk } from '@tinfoilsh/tinfoil-icons'
import { TfGhost2Animated } from '@tinfoilsh/tinfoil-icons/animated'
import { cn } from '../ui/utils'
import { formatRelativeTime } from './chat-list-utils'
import type { Chat } from './types'

const INITIAL_TURN_MESSAGE_COUNT = 2

interface ChatHeaderProps {
  chat: Chat
  isStreaming: boolean
  isLoading?: boolean
  /** The chat could not be opened, so it has no title or times to show. */
  isUnavailable?: boolean
  /** The harness has saved the chat as it shows. */
  isSynced?: boolean
  /** Action buttons rendered at the trailing edge of the header. */
  actions: React.ReactNode
  leadingAction?: React.ReactNode
  notice?: React.ReactNode
  className?: string
}

type StorageStatus =
  { kind: 'temporary' } | { kind: 'local' } | { kind: 'synced' } | null

function resolveStorageStatus(chat: Chat, isSynced: boolean): StorageStatus {
  if (chat.isTemporary) return { kind: 'temporary' }
  if (chat.isLocalOnly) return { kind: 'local' }
  if (isSynced) return { kind: 'synced' }
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
  isLoading = false,
  isUnavailable = false,
  isSynced = false,
  actions,
  leadingAction,
  notice,
  className,
}: ChatHeaderProps) {
  const storageStatus = resolveStorageStatus(chat, isSynced)

  const createdAt = toDate(chat.createdAt)
  // "Updated" is the last conversation activity, the same time the chat
  // list is ordered by; a rename or a settings change does not move it.
  const updatedAt = toDate(chat.activityAt ?? chat.updatedAt) ?? createdAt
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
  if (storageStatus) {
    metaItems.push(
      <span key="storage" className="flex min-w-0 items-center gap-1">
        {storageStatus.kind === 'temporary' ? (
          <span className="flex min-w-0 items-center gap-1 text-orange-500">
            <TfGhost2Animated
              className="h-3 w-3 flex-none"
              aria-hidden="true"
            />
            <span className="truncate">Temporary chat</span>
          </span>
        ) : storageStatus.kind === 'local' ? (
          <>
            <TfFloppyDisk
              className="h-3.5 w-3.5 flex-none"
              aria-hidden="true"
            />
            <span className="truncate">Only saved locally</span>
          </>
        ) : (
          <>
            <TfCloud className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span className="truncate">Synced</span>
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
        {!isUnavailable && (
          <div className="min-w-0 flex-1">
            <h1
              className="truncate font-aeonik text-sm font-medium text-content-primary"
              title={isLoading ? undefined : chat.title}
            >
              {isLoading ? (
                <>
                  <span className="sr-only">Loading chat</span>
                  <span
                    aria-hidden="true"
                    className="my-1 block h-3 w-40 max-w-full animate-pulse rounded bg-surface-chat"
                  />
                </>
              ) : (
                chat.title
              )}
            </h1>
            {isLoading ? (
              <div aria-hidden="true" className="mt-0.5 flex h-4 items-center">
                <span className="h-2 w-20 animate-pulse rounded bg-surface-chat" />
              </div>
            ) : (
              metaItems.length > 0 && (
                // The items fill the line from its end, so where there is no
                // room the earliest give way first, onto a second line the
                // header hides, rather than show cut off. The last, as the
                // storage status, stays, and shortens only when it alone has
                // no room.
                <p className="mt-0.5 flex h-4 min-w-0 flex-row-reverse flex-wrap items-center justify-end gap-x-1.5 overflow-hidden whitespace-nowrap font-aeonik-fono text-xs leading-4 text-content-muted">
                  {metaItems.map((item, index) => {
                    const fromEnd = metaItems.length - 1 - index
                    return (
                      <span
                        key={index}
                        style={{ order: fromEnd }}
                        className={cn(
                          'flex items-center gap-1.5',
                          fromEnd === 0 ? 'min-w-0' : 'flex-none',
                        )}
                      >
                        {item}
                        {fromEnd > 0 && <span aria-hidden="true">·</span>}
                      </span>
                    )
                  })}
                </p>
              )
            )}
          </div>
        )}
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
