'use client'

import { Fragment, useEffect, useState } from 'react'
import { cn } from '../ui/utils'
import {
  type ChatItemData,
  ChatListItem,
  getBlankChatSelectId,
  getChatKey,
  type ProjectOption,
} from './chat-list-item'
import { DeleteConfirmation } from './delete-confirmation'

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded bg-content-muted/20', className)}
    />
  )
}

interface ChatListProps {
  chats: ChatItemData[]
  currentChatId?: string
  currentChatIsBlank?: boolean
  currentChatIsLocalOnly?: boolean
  isDarkMode: boolean
  pixelateSidebarChatTitles: boolean
  isLoading?: boolean
  enableTitleAnimation?: boolean
  animatedDeleteConfirmation?: boolean
  isDraggable?: boolean
  showMoveToProject?: boolean
  projects?: ProjectOption[]
  getChatHref?: (chat: ChatItemData) => string | undefined
  onSelectChat: (chatId: string) => void
  onAfterSelect?: () => void
  onUpdateTitle?: (chatId: string, title: string) => void
  onDeleteChat: (chatId: string) => void
  onDragStart?: (chatId: string) => void
  onDragEnd?: () => void
  onMoveToProject?: (chatId: string, projectId: string) => void
  onConvertToCloud?: (chatId: string) => void
  onConvertToLocal?: (chatId: string) => void
  onRemoveFromProject?: (chatId: string) => void
  pinnedChatIds?: readonly string[]
  showPinnedIndicators?: boolean
  showDesktopPinActions?: boolean
  onTogglePin?: (chat: ChatItemData) => void | Promise<void>
  // Whether a chat kept on this device offers pinning, which moves it to
  // the cloud first.
  canPinLocalChats?: boolean
  loadMoreButton?: React.ReactNode
  emptyState?: React.ReactNode
}

export function ChatList({
  chats,
  currentChatId,
  currentChatIsBlank,
  currentChatIsLocalOnly,
  isDarkMode,
  pixelateSidebarChatTitles,
  isLoading = false,
  enableTitleAnimation = false,
  animatedDeleteConfirmation = true,
  isDraggable = false,
  showMoveToProject = false,
  projects = [],
  getChatHref,
  onSelectChat,
  onAfterSelect,
  onUpdateTitle,
  onDeleteChat,
  onDragStart,
  onDragEnd,
  onMoveToProject,
  onConvertToCloud,
  onConvertToLocal,
  onRemoveFromProject,
  pinnedChatIds = [],
  showPinnedIndicators = true,
  showDesktopPinActions = true,
  onTogglePin,
  canPinLocalChats = false,
  loadMoreButton,
  emptyState,
}: ChatListProps) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null)
  // Track chat IDs that were manually edited - skip animation for these
  const [manuallyEditedChatId, setManuallyEditedChatId] = useState<
    string | null
  >(null)

  // Clear the manually edited flag after the title update has propagated
  useEffect(
    () => {
      if (manuallyEditedChatId) {
        setManuallyEditedChatId(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally only depends on chats
    [chats],
  )

  const isSelected = (chat: ChatItemData): boolean => {
    if (chat.isBlankChat) {
      return (
        currentChatIsBlank === true &&
        chat.isLocalOnly === currentChatIsLocalOnly
      )
    }
    return currentChatId === chat.id
  }

  const handleSelect = (chat: ChatItemData) => {
    if (chat.isBlankChat) {
      onSelectChat(getBlankChatSelectId(chat))
    } else {
      onSelectChat(chat.id)
    }

    onAfterSelect?.()
  }

  const handleStartEdit = (chat: ChatItemData) => {
    setEditingTitle(chat.title)
    setEditingChatId(chat.id)
  }

  const handleSaveTitle = (chatId: string) => {
    if (editingTitle.trim() && onUpdateTitle) {
      // Mark this chat as manually edited to skip animation
      setManuallyEditedChatId(chatId)
      onUpdateTitle(chatId, editingTitle.trim())
    }
    setEditingChatId(null)
  }

  const handleCancelEdit = () => {
    setEditingChatId(null)
  }

  const handleConfirmDelete = (chatId: string) => {
    onDeleteChat(chatId)
    setDeletingChatId(null)
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-2" role="status" aria-label="Loading chats">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'rounded-lg px-3 py-2',
              isDarkMode ? 'bg-surface-chat' : 'bg-white',
            )}
          >
            <Shimmer className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    )
  }

  const visibleChats = chats

  if (visibleChats.length === 0 && emptyState) {
    return (
      <div className="space-y-2 p-2">
        <div className="p-2">{emptyState}</div>
      </div>
    )
  }

  return (
    <>
      <div role="list" className="chat-title-privacy-region space-y-2 p-2">
        {visibleChats.map((chat) => (
          <Fragment key={getChatKey(chat)}>
            <div role="listitem" className="relative">
              <ChatListItem
                chat={chat}
                isSelected={isSelected(chat)}
                isEditing={editingChatId === chat.id}
                editingTitle={editingTitle}
                isDarkMode={isDarkMode}
                pixelateSidebarChatTitles={pixelateSidebarChatTitles}
                isStreaming={!chat.isBlankChat && !!chat.activeRun}
                isFlagged={!!chat.flagged}
                enableTitleAnimation={
                  enableTitleAnimation && manuallyEditedChatId !== chat.id
                }
                isDraggable={isDraggable && !chat.isBlankChat}
                showMoveToProject={showMoveToProject && !chat.isBlankChat}
                projects={projects}
                href={getChatHref?.(chat)}
                onSelect={() => handleSelect(chat)}
                onStartEdit={() => handleStartEdit(chat)}
                onTitleChange={setEditingTitle}
                onSaveTitle={() => handleSaveTitle(chat.id)}
                onCancelEdit={handleCancelEdit}
                onRequestDelete={() => setDeletingChatId(chat.id)}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onMoveToProject={
                  onMoveToProject
                    ? (projectId) => onMoveToProject(chat.id, projectId)
                    : undefined
                }
                onConvertToCloud={
                  onConvertToCloud ? () => onConvertToCloud(chat.id) : undefined
                }
                onConvertToLocal={
                  onConvertToLocal ? () => onConvertToLocal(chat.id) : undefined
                }
                onRemoveFromProject={
                  onRemoveFromProject
                    ? () => onRemoveFromProject(chat.id)
                    : undefined
                }
                isPinned={pinnedChatIds.includes(chat.id)}
                showPinnedIndicator={showPinnedIndicators}
                showDesktopPinAction={showDesktopPinActions}
                onTogglePin={onTogglePin ? () => onTogglePin(chat) : undefined}
                canPinLocalChats={canPinLocalChats}
              />
              {deletingChatId === chat.id && (
                <DeleteConfirmation
                  onConfirm={() => handleConfirmDelete(chat.id)}
                  onCancel={() => setDeletingChatId(null)}
                  isDarkMode={isDarkMode}
                  animated={animatedDeleteConfirmation}
                />
              )}
            </div>
          </Fragment>
        ))}
      </div>
      {loadMoreButton}
    </>
  )
}

export { type ChatItemData } from './chat-list-item'
