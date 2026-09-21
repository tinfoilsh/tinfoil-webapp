'use client'

import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { canRequestChatPin } from '@/services/storage/pinned-chats'
import { isPlainPrimaryClick } from '@/utils/navigation'
import {
  CheckIcon,
  CloudIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { FlagIcon } from '@heroicons/react/24/solid'
import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CiFloppyDisk } from 'react-icons/ci'
import { PiPushPin, PiPushPinFill, PiSpinner } from 'react-icons/pi'
import { FaLock } from '../icons/lazy-icons'
import { RedactedText } from '../ui/redacted-text'
import { cn } from '../ui/utils'
import { getBlankQueueId } from './message-queue-identity'
import { TypingAnimation } from './typing-animation'

export interface ChatItemData {
  id: string
  title: string
  isBlankChat?: boolean
  messageCount?: number
  messages?: { length: number }
  isMetadataOnly?: boolean
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  isLocalOnly?: boolean
  isTemporary?: boolean
  projectId?: string
  /** True while the chat's first save (e.g. a fork) is still landing. */
  pendingSave?: boolean
}

export function canPinChat(chat: ChatItemData): boolean {
  return canRequestChatPin(chat)
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
  return getBlankQueueId(chat.isLocalOnly === true)
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
  /**
   * True while this chat's assistant response is actively streaming.
   * Drives the live "streaming" indicator.
   */
  isStreaming?: boolean
  /**
   * True when the safeguards service flagged this chat for review. Shows a
   * red flag so the user can find the chat from the Safeguards settings
   * page.
   */
  isFlagged?: boolean
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
  isPinned?: boolean
  showPinnedIndicator?: boolean
  showDesktopPinAction?: boolean
  onTogglePin?: () => void | Promise<void>
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
  isStreaming = false,
  isFlagged = false,
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
  isPinned = false,
  showPinnedIndicator = true,
  showDesktopPinAction = true,
  onTogglePin,
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

  // Metadata-only summaries carry an empty messages array as a
  // placeholder, so the stored count is the truthful one for them.
  const messageCount = chat.isMetadataOnly
    ? (chat.messageCount ?? 0)
    : (chat.messages?.length ?? chat.messageCount ?? 0)
  const isNewChat = messageCount === 0 && !chat.decryptionFailed
  const hasRealTitle = !chat.isBlankChat && !chat.decryptionFailed
  const shouldRedactTitle =
    pixelateSidebarChatTitles && hasRealTitle && !isNewChat && !isSelected

  useEffect(() => {
    if (shouldRedactTitle) {
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
  }, [chat.title, enableTitleAnimation, shouldRedactTitle])

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
    // privacy region and keep protected titles revealed after the drop.
    // Scoped to this row so dragging never steals focus from unrelated
    // controls (e.g. a rename input on another row or the search field).
    if (
      document.activeElement instanceof HTMLElement &&
      e.currentTarget.contains(document.activeElement)
    ) {
      document.activeElement.blur()
    }
    setIsDragging(true)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData('text/plain', chat.id)
    e.dataTransfer.setData('application/x-chat-id', chat.id)
    onDragStart?.(chat.id)
  }

  const handleDragEnd = () => {
    setIsDragging(false)
    onDragEnd?.()
  }

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
              className="min-w-0 flex-1 rounded bg-surface-sidebar px-2 py-1 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-tinfoil-accent-blue"
              value={editingTitle}
              onChange={(e) => onTitleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="submit"
              className="ml-auto flex-shrink-0 rounded p-1 text-tinfoil-accent-blue transition-colors hover:bg-tinfoil-accent-blue-subtle"
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
              <RedactedText
                active={shouldRedactTitle}
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
              </RedactedText>
              {isStreaming ? (
                <span
                  className="mx-2 flex w-[18px] flex-shrink-0 items-center justify-center"
                  title="Generating response"
                >
                  <span className="stream-loader" />
                  <span className="sr-only">Generating response</span>
                </span>
              ) : chat.pendingSave ? (
                <span
                  className="mx-2 flex w-[18px] flex-shrink-0 items-center justify-center text-content-muted"
                  title="Forking conversation"
                >
                  <PiSpinner className="h-3.5 w-3.5 animate-spin" />
                  <span className="sr-only">Forking conversation</span>
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
              {isPinned && showPinnedIndicator && !isStreaming && (
                <PiPushPinFill
                  className="h-3.5 w-3.5 flex-shrink-0 text-content-muted"
                  title="Pinned to Favorites"
                  aria-label="Pinned to Favorites"
                />
              )}
              {isFlagged && (
                <FlagIcon
                  className="h-3.5 w-3.5 flex-shrink-0 -translate-y-px text-red-600"
                  title="Flagged by safeguards"
                  aria-label="Flagged by safeguards"
                />
              )}
            </span>
            {chat.decryptionFailed && (
              <span className="mt-1 block text-xs text-red-500">
                {chat.dataCorrupted
                  ? 'Failed to decrypt: corrupted data'
                  : 'Failed to decrypt: wrong key'}
              </span>
            )}
          </>
        </ChatSelectionControl>
      )}

      {!isEditing && (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <div className="pointer-events-none hidden items-center opacity-0 transition-opacity md:flex md:w-0 md:overflow-hidden md:group-focus-within:pointer-events-auto md:group-focus-within:w-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:w-auto md:group-hover:opacity-100">
            {showDesktopPinAction &&
              (isPinned || canPinChat(chat)) &&
              onTogglePin && (
                <button
                  type="button"
                  className={cn(
                    'mr-1 rounded p-1 transition-colors',
                    isPinned
                      ? 'text-content-primary'
                      : 'text-content-muted hover:text-content-secondary',
                    isDarkMode
                      ? 'hover:bg-surface-chat hover:text-white'
                      : 'hover:bg-surface-sidebar',
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onTogglePin()
                  }}
                  aria-label={
                    isPinned ? 'Remove from Favorites' : 'Pin to Favorites'
                  }
                  title={
                    isPinned ? 'Remove from Favorites' : 'Pin to Favorites'
                  }
                >
                  {isPinned ? (
                    <PiPushPinFill className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <PiPushPin className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              )}
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

                        {(isPinned || canPinChat(chat)) && onTogglePin && (
                          <button
                            type="button"
                            role="menuitem"
                            className={cn(
                              'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
                              isDarkMode
                                ? 'text-content-secondary hover:bg-surface-sidebar'
                                : 'text-content-secondary hover:bg-gray-100',
                            )}
                            onClick={(event) => {
                              event.stopPropagation()
                              setIsMobileMenuOpen(false)
                              setMobileMenuView('main')
                              void onTogglePin()
                            }}
                          >
                            {isPinned ? (
                              <PiPushPinFill
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            ) : (
                              <PiPushPin
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            )}
                            {isPinned
                              ? 'Remove from Favorites'
                              : 'Pin to Favorites'}
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
