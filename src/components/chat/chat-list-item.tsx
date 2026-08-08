'use client'

import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { isPlainPrimaryClick } from '@/utils/navigation'
import {
  CheckIcon,
  CloudArrowUpIcon,
  CloudIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import Link from 'next/link'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CiFloppyDisk } from 'react-icons/ci'
import { FaLock } from '../icons/lazy-icons'
import { PixelatedText } from '../ui/pixelated-text'
import { cn } from '../ui/utils'
import { formatRelativeTime } from './chat-list-utils'
import { TypingAnimation } from './typing-animation'

export interface ChatItemData {
  id: string
  title: string
  isBlankChat?: boolean
  createdAt?: Date | string
  updatedAt?: string
  messageCount?: number
  messages?: { length: number }
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  isLocalOnly?: boolean
  pendingSave?: boolean
}

/**
 * Generates a unique key for a chat item, handling blank chats specially
 */
export function getChatKey(chat: ChatItemData): string {
  if (chat.isBlankChat) {
    return `blank-${chat.isLocalOnly ? 'local' : 'cloud'}`
  }
  return chat.id
}

/**
 * Generates the ID to pass to onSelectChat for blank chats
 */
export function getBlankChatSelectId(chat: ChatItemData): string {
  return chat.isLocalOnly ? 'blank-local' : 'blank-cloud'
}

const toDate = (value?: Date | string): Date | null => {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}

export interface ProjectOption {
  id: string
  name: string
}

interface ChatListItemProps {
  chat: ChatItemData
  isSelected: boolean
  isEditing: boolean
  editingTitle: string
  isDarkMode: boolean
  pixelateSidebarChatTitles: boolean
  showEncryptionStatus?: boolean
  showSyncStatus?: boolean
  /**
   * True while this chat's assistant response is actively streaming.
   * Drives the live "streaming" indicator and suppresses the "Syncing
   * with cloud" badge (the upload is deferred until the stream finishes).
   */
  isStreaming?: boolean
  /**
   * True when this chat's last upload attempt failed terminally
   * (per the sync-health store). Shows a quiet warning icon so the
   * failure is visible without blocking anything.
   */
  syncFailed?: boolean
  enableTitleAnimation?: boolean
  isDraggable?: boolean
  showMoveToProject?: boolean
  projects?: ProjectOption[]
  href?: string
  onSelect: () => void
  onStartEdit: () => void
  onTitleChange: (title: string) => void
  onSaveTitle: () => void
  onCancelEdit: () => void
  onRequestDelete: () => void
  onDragStart?: (chatId: string) => void
  onDragEnd?: () => void
  onMoveToProject?: (projectId: string) => void
  onConvertToCloud?: () => void
  onConvertToLocal?: () => void
  onRemoveFromProject?: () => void
}

function ChatSelectionControl({
  href,
  isSelected,
  onSelect,
  children,
}: {
  href?: string
  isSelected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  const className =
    'min-w-0 flex-1 cursor-pointer rounded-md pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong'
  const ariaCurrent = isSelected ? 'page' : undefined

  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        draggable={false}
        aria-current={ariaCurrent}
        className={className}
        onClick={(event) => {
          if (event.defaultPrevented || !isPlainPrimaryClick(event)) return
          event.preventDefault()
          onSelect()
        }}
      >
        {children}
      </Link>
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={ariaCurrent}
      className={className}
    >
      {children}
    </button>
  )
}

export function ChatListItem({
  chat,
  isSelected,
  isEditing,
  editingTitle,
  isDarkMode,
  pixelateSidebarChatTitles,
  showEncryptionStatus = false,
  showSyncStatus = false,
  isStreaming = false,
  syncFailed = false,
  enableTitleAnimation = false,
  isDraggable = false,
  showMoveToProject = false,
  projects = [],
  href,
  onSelect,
  onStartEdit,
  onTitleChange,
  onSaveTitle,
  onCancelEdit,
  onRequestDelete,
  onDragStart,
  onDragEnd,
  onMoveToProject,
  onConvertToCloud,
  onConvertToLocal,
  onRemoveFromProject,
}: ChatListItemProps) {
  const [displayTitle, setDisplayTitle] = useState(chat.title)
  const [isAnimating, setIsAnimating] = useState(false)
  const [animationFromTitle, setAnimationFromTitle] = useState('')
  const [animationToTitle, setAnimationToTitle] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [mobileMenuView, setMobileMenuView] = useState<'main' | 'projects'>(
    'main',
  )
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const mobileMenuId = useId()
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileMenuPortalRef = useRef<HTMLDivElement>(null)
  const prevTitleRef = useRef(chat.title)

  const messageCount = chat.messages?.length ?? chat.messageCount ?? 0
  const isNewChat = messageCount === 0 && !chat.decryptionFailed
  const hasRealTitle = !chat.isBlankChat && !chat.decryptionFailed
  const shouldPixelateTitle =
    pixelateSidebarChatTitles && hasRealTitle && !isNewChat && !isSelected

  useEffect(() => {
    if (shouldPixelateTitle) {
      setDisplayTitle(chat.title)
      setIsAnimating(false)
      prevTitleRef.current = chat.title
      return
    }

    if (
      enableTitleAnimation &&
      prevTitleRef.current !== chat.title &&
      chat.title !== DEFAULT_CHAT_TITLE &&
      prevTitleRef.current !== ''
    ) {
      setAnimationFromTitle(prevTitleRef.current)
      setAnimationToTitle(chat.title)
      setIsAnimating(true)
    } else {
      setDisplayTitle(chat.title)
      prevTitleRef.current = chat.title
    }
  }, [chat.title, enableTitleAnimation, shouldPixelateTitle])

  const handleAnimationComplete = () => {
    setDisplayTitle(chat.title)
    setIsAnimating(false)
    prevTitleRef.current = chat.title
  }

  // Close mobile menu when clicking outside
  useEffect(() => {
    if (!isMobileMenuOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const isInsideButton = mobileMenuButtonRef.current?.contains(target)
      const isInsideMenu = mobileMenuPortalRef.current?.contains(target)

      if (!isInsideButton && !isInsideMenu) {
        setIsMobileMenuOpen(false)
        setMobileMenuView('main')
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsMobileMenuOpen(false)
      setMobileMenuView('main')
      mobileMenuButtonRef.current?.focus()
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    const frame = requestAnimationFrame(() => {
      mobileMenuPortalRef.current?.querySelector('button')?.focus()
    })
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      cancelAnimationFrame(frame)
    }
  }, [isMobileMenuOpen, mobileMenuView])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (editingTitle.trim()) {
      onSaveTitle()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancelEdit()
    }
  }

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStartEdit()
  }

  const handleRequestDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRequestDelete()
  }

  const handleDragStart = (e: React.DragEvent) => {
    if (!isDraggable) {
      e.preventDefault()
      return
    }
    // The mousedown that initiates a drag focuses the row's link, and since
    // the drag suppresses the click, focus would stay parked inside the
    // privacy region and keep pixelated titles revealed after the drop.
    // Scoped to this row so dragging never steals focus from unrelated
    // controls (e.g. a rename input on another row or the search field).
    if (
      document.activeElement instanceof HTMLElement &&
      e.currentTarget.contains(document.activeElement)
    ) {
      document.activeElement.blur()
    }
    setIsDragging(true)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', chat.id)
    e.dataTransfer.setData('application/x-chat-id', chat.id)
    onDragStart?.(chat.id)
  }

  const handleDragEnd = () => {
    setIsDragging(false)
    onDragEnd?.()
  }

  const createdAtInput =
    chat.createdAt instanceof Date
      ? chat.createdAt.toISOString()
      : chat.createdAt
  const { createdAt, timestamp, createdRelativeTime, updatedRelativeTime } =
    useMemo(() => {
      const created = toDate(createdAtInput)
      const updated = toDate(chat.updatedAt) ?? created
      return {
        createdAt: created,
        timestamp: updated,
        createdRelativeTime: updated
          ? formatRelativeTime(created ?? updated)
          : null,
        updatedRelativeTime: updated ? formatRelativeTime(updated) : null,
      }
    }, [chat.updatedAt, createdAtInput])
  // Skip the updated time when it would read the same as the created
  // time, so rows don't repeat "9h ago · Updated 9h ago". Without a
  // createdAt there is nothing to compare against and the timestamp
  // may itself be the creation time, so show it unlabeled instead of
  // claiming "Updated".
  const showUpdatedTime =
    !isStreaming &&
    timestamp !== null &&
    createdAt !== null &&
    updatedRelativeTime !== createdRelativeTime

  return (
    <div
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={cn(
        'group flex w-full items-center justify-between rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors hover:border-border-subtle',
        isDraggable && 'cursor-grab',
        isDragging && 'opacity-50',
        chat.decryptionFailed
          ? 'text-content-muted hover:bg-surface-chat'
          : isSelected
            ? isDarkMode
              ? 'bg-surface-chat text-white'
              : 'bg-gray-200 text-content-primary'
            : isDarkMode
              ? 'text-content-secondary hover:bg-surface-chat'
              : 'text-content-secondary hover:bg-surface-sidebar',
      )}
    >
      {isEditing ? (
        <div className="min-w-0 flex-1 pr-2">
          <form
            onSubmit={handleSubmit}
            className="flex w-full items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              aria-label="Chat title"
              className="min-w-0 flex-1 rounded bg-surface-sidebar px-2 py-1 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={editingTitle}
              onChange={(e) => onTitleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="submit"
              className="ml-auto flex-shrink-0 rounded p-1 text-green-500 transition-colors hover:bg-green-500/10"
              title="Save"
              aria-label="Save chat title"
            >
              <CheckIcon className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onCancelEdit()
              }}
              className="flex-shrink-0 rounded p-1 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-secondary"
              title="Cancel"
              aria-label="Cancel rename"
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      ) : (
        <ChatSelectionControl
          href={href}
          isSelected={isSelected}
          onSelect={onSelect}
        >
          <>
            <span className="flex items-center gap-1.5">
              {showEncryptionStatus && chat.decryptionFailed && (
                <FaLock
                  className="h-3.5 w-3.5 flex-shrink-0 text-orange-500"
                  title="Encrypted chat"
                  aria-hidden="true"
                />
              )}
              <PixelatedText
                text={displayTitle}
                active={shouldPixelateTitle}
                renderKey={isDarkMode}
                className={cn(
                  'truncate font-aeonik-fono text-sm font-medium',
                  chat.decryptionFailed
                    ? 'text-orange-500'
                    : 'text-content-primary',
                )}
              >
                {chat.decryptionFailed ? (
                  'Encrypted'
                ) : isAnimating ? (
                  <TypingAnimation
                    fromText={animationFromTitle}
                    toText={animationToTitle}
                    onComplete={handleAnimationComplete}
                  />
                ) : (
                  displayTitle
                )}
              </PixelatedText>
              {isStreaming ? (
                <span
                  className="mx-2 flex w-[18px] flex-shrink-0 items-center justify-center"
                  title="Generating response"
                >
                  <span className="stream-loader" />
                  <span className="sr-only">Generating response</span>
                </span>
              ) : (
                isNewChat && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-blue-500"
                    title="New chat"
                    aria-hidden="true"
                  />
                )
              )}
            </span>
            {(chat.decryptionFailed ||
              (messageCount > 0 && timestamp) ||
              (showSyncStatus &&
                (chat.isLocalOnly ||
                  (!chat.isBlankChat && syncFailed) ||
                  (!chat.isBlankChat &&
                    chat.pendingSave &&
                    !isStreaming)))) && (
              <span className="mt-1 flex min-h-[16px] w-full flex-wrap items-center gap-2 @container">
                {chat.decryptionFailed ? (
                  <span className="text-xs text-red-500">
                    {chat.dataCorrupted
                      ? 'Failed to decrypt: corrupted data'
                      : 'Failed to decrypt: wrong key'}
                  </span>
                ) : messageCount > 0 && timestamp ? (
                  <span className="text-xs leading-none text-content-muted">
                    <span className="text-content-secondary">
                      {createdRelativeTime}
                    </span>
                    {showUpdatedTime && <> · Updated {updatedRelativeTime}</>}
                  </span>
                ) : null}
                {showSyncStatus && (
                  <>
                    {chat.isLocalOnly ? (
                      <span className="flex items-center gap-0.5 whitespace-nowrap text-xs leading-none text-content-muted">
                        {messageCount > 0 && (
                          <span className="mr-1.5 hidden text-content-muted @xs:inline">
                            ·
                          </span>
                        )}
                        <CiFloppyDisk className="h-3 w-3" aria-hidden="true" />
                        Only saved locally
                      </span>
                    ) : !chat.isBlankChat && syncFailed ? (
                      <span
                        className="flex items-center text-orange-500"
                        title="This chat couldn't be synced"
                      >
                        <ExclamationTriangleIcon
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        <span className="sr-only">
                          This chat couldn&apos;t be synced
                        </span>
                      </span>
                    ) : !chat.isBlankChat &&
                      chat.pendingSave &&
                      !isStreaming ? (
                      <span
                        className="flex items-center text-blue-500"
                        title="Syncing with cloud"
                      >
                        <CloudArrowUpIcon
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        <span className="sr-only">Syncing with cloud</span>
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            )}
          </>
        </ChatSelectionControl>
      )}

      {!isEditing && (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <div className="pointer-events-none hidden items-center opacity-0 transition-opacity md:flex md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:opacity-100">
            {hasRealTitle && (
              <button
                type="button"
                className={cn(
                  'mr-1 rounded p-1 transition-colors',
                  isDarkMode
                    ? 'text-content-muted hover:bg-surface-chat hover:text-white'
                    : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
                )}
                onClick={handleStartEdit}
                aria-label="Rename chat"
                title="Rename"
              >
                <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            {!chat.isBlankChat && (
              <button
                type="button"
                className={cn(
                  'rounded p-1 transition-colors',
                  isDarkMode
                    ? 'text-content-muted hover:bg-surface-chat hover:text-white'
                    : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
                )}
                onClick={handleRequestDelete}
                aria-label="Delete chat"
                title="Delete"
              >
                <TrashIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {/* Mobile: three-dot menu */}
          {!chat.isBlankChat && (
            <div className="flex items-center md:hidden">
              <button
                ref={mobileMenuButtonRef}
                type="button"
                className={cn(
                  'rounded p-1 transition-colors',
                  isDarkMode
                    ? 'text-content-muted hover:bg-surface-chat hover:text-white'
                    : 'text-content-muted hover:bg-surface-sidebar hover:text-content-secondary',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isMobileMenuOpen) {
                    setIsMobileMenuOpen(false)
                    setMobileMenuView('main')
                  } else {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setMenuPosition({
                      top: rect.bottom + 4,
                      left: rect.right,
                    })
                    setIsMobileMenuOpen(true)
                  }
                }}
                title="More options"
                aria-label="More chat options"
                aria-haspopup="menu"
                aria-expanded={isMobileMenuOpen}
                aria-controls={isMobileMenuOpen ? mobileMenuId : undefined}
              >
                <EllipsisVerticalIcon className="h-5 w-5" aria-hidden="true" />
              </button>

              {/* Mobile dropdown menu - rendered via portal to escape overflow constraints */}
              {isMobileMenuOpen &&
                createPortal(
                  <div
                    id={mobileMenuId}
                    ref={mobileMenuPortalRef}
                    role="menu"
                    aria-label={`Actions for ${displayTitle}`}
                    className={cn(
                      'fixed z-[9999] min-w-[200px] rounded-lg border py-1 shadow-lg',
                      isDarkMode
                        ? 'border-border-subtle bg-surface-chat'
                        : 'border-border-subtle bg-white',
                    )}
                    style={{
                      top: menuPosition.top,
                      left: menuPosition.left,
                      transform: 'translateX(-100%)',
                    }}
                  >
                    {mobileMenuView === 'main' ? (
                      <>
                        {/* Rename */}
                        {!chat.decryptionFailed && (
                          <button
                            type="button"
                            role="menuitem"
                            className={cn(
                              'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                              isDarkMode
                                ? 'text-content-secondary hover:bg-surface-sidebar'
                                : 'text-content-secondary hover:bg-gray-100',
                            )}
                            onClick={(e) => {
                              e.stopPropagation()
                              setIsMobileMenuOpen(false)
                              setMobileMenuView('main')
                              onStartEdit()
                            }}
                          >
                            <PencilSquareIcon
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            Rename
                          </button>
                        )}

                        {/* Move to project - opens submenu */}
                        {showMoveToProject &&
                          onMoveToProject &&
                          !chat.decryptionFailed &&
                          projects.length > 0 && (
                            <button
                              type="button"
                              role="menuitem"
                              aria-haspopup="menu"
                              className={cn(
                                'flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors',
                                isDarkMode
                                  ? 'text-content-secondary hover:bg-surface-sidebar'
                                  : 'text-content-secondary hover:bg-gray-100',
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMobileMenuView('projects')
                              }}
                            >
                              <span className="flex items-center gap-3">
                                <FolderIcon
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                Move to project
                              </span>
                              <svg
                                className="h-4 w-4 text-content-muted"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                            </button>
                          )}

                        {/* Move out of project */}
                        {onRemoveFromProject && !chat.decryptionFailed && (
                          <button
                            type="button"
                            role="menuitem"
                            className={cn(
                              'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                              isDarkMode
                                ? 'text-content-secondary hover:bg-surface-sidebar'
                                : 'text-content-secondary hover:bg-gray-100',
                            )}
                            onClick={(e) => {
                              e.stopPropagation()
                              setIsMobileMenuOpen(false)
                              setMobileMenuView('main')
                              onRemoveFromProject()
                            }}
                          >
                            <FolderIcon
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                            Move out of project
                          </button>
                        )}

                        {/* Move to cloud (if local) */}
                        {chat.isLocalOnly &&
                          onConvertToCloud &&
                          !chat.decryptionFailed && (
                            <button
                              type="button"
                              role="menuitem"
                              className={cn(
                                'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                                isDarkMode
                                  ? 'text-content-secondary hover:bg-surface-sidebar'
                                  : 'text-content-secondary hover:bg-gray-100',
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                setIsMobileMenuOpen(false)
                                setMobileMenuView('main')
                                onConvertToCloud()
                              }}
                            >
                              <CloudIcon
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Move to cloud
                            </button>
                          )}

                        {/* Move to local (if cloud) */}
                        {!chat.isLocalOnly &&
                          onConvertToLocal &&
                          !chat.decryptionFailed && (
                            <button
                              type="button"
                              role="menuitem"
                              className={cn(
                                'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                                isDarkMode
                                  ? 'text-content-secondary hover:bg-surface-sidebar'
                                  : 'text-content-secondary hover:bg-gray-100',
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                setIsMobileMenuOpen(false)
                                setMobileMenuView('main')
                                onConvertToLocal()
                              }}
                            >
                              <CiFloppyDisk
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Move to local
                            </button>
                          )}

                        {/* Delete */}
                        <button
                          type="button"
                          role="menuitem"
                          className={cn(
                            'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                            'text-red-500 hover:bg-red-500/10',
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            setIsMobileMenuOpen(false)
                            setMobileMenuView('main')
                            onRequestDelete()
                          }}
                        >
                          <TrashIcon className="h-4 w-4" aria-hidden="true" />
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Projects submenu */}
                        {/* Back button */}
                        <button
                          type="button"
                          role="menuitem"
                          className={cn(
                            'flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-sm font-medium transition-colors',
                            isDarkMode
                              ? 'border-border-subtle text-content-primary hover:bg-surface-sidebar'
                              : 'border-border-subtle text-content-primary hover:bg-gray-100',
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            setMobileMenuView('main')
                          }}
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 19l-7-7 7-7"
                            />
                          </svg>
                          Back
                        </button>

                        {/* Project list */}
                        <div className="max-h-[200px] overflow-y-auto">
                          {projects.map((project) => (
                            <button
                              type="button"
                              role="menuitem"
                              key={project.id}
                              className={cn(
                                'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                                isDarkMode
                                  ? 'text-content-secondary hover:bg-surface-sidebar'
                                  : 'text-content-secondary hover:bg-gray-100',
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                setIsMobileMenuOpen(false)
                                setMobileMenuView('main')
                                onMoveToProject?.(project.id)
                              }}
                            >
                              <FolderIcon
                                className="h-4 w-4 text-content-muted"
                                aria-hidden="true"
                              />
                              <span className="truncate">{project.name}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>,
                  document.body,
                )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
