'use client'

import { useSyncFailedChats } from '@/hooks/use-sync-health'
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
  isLoading?: boolean
  showEncryptionStatus?: boolean
  showSyncStatus?: boolean
  /**
   * ID of the chat whose assistant response is currently streaming, if
   * any. Used to suppress the "Syncing with cloud" badge until the
   * stream finishes and the real upload happens.
   */
  streamingChatId?: string
  enableTitleAnimation?: boolean
  animatedDeleteConfirmation?: boolean
  isDraggable?: boolean
  showMoveToProject?: boolean
  projects?: ProjectOption[]
  onSelectChat: (chatId: string) => void
  onAfterSelect?: () => void
  onUpdateTitle?: (chatId: string, title: string) => void
  onDeleteChat: (chatId: string) => void
  onEncryptionKeyClick?: () => void
  onDragStart?: (chatId: string) => void
  onDragEnd?: () => void
  onMoveToProject?: (chatId: string, projectId: string) => void
  onConvertToCloud?: (chatId: string) => void
  onConvertToLocal?: (chatId: string) => void
  onRemoveFromProject?: (chatId: string) => void
  loadMoreButton?: React.ReactNode
  emptyState?: React.ReactNode
  /**
   * Optional indicator rendered directly after the blank "New Chat"
   * item (and before the chat history). Used to show a "Loading chats"
   * spinner while the post-unlock decryption runs.
   */
  loadingIndicator?: React.ReactNode
}

export function ChatList({
  chats,
  currentChatId,
  currentChatIsBlank,
  currentChatIsLocalOnly,
  isDarkMode,
  isLoading = false,
  showEncryptionStatus = false,
  showSyncStatus = false,
  streamingChatId,
  enableTitleAnimation = false,
  animatedDeleteConfirmation = true,
  isDraggable = false,
  showMoveToProject = false,
  projects = [],
  onSelectChat,
  onAfterSelect,
  onUpdateTitle,
  onDeleteChat,
  onEncryptionKeyClick,
  onDragStart,
  onDragEnd,
  onMoveToProject,
  onConvertToCloud,
  onConvertToLocal,
  onRemoveFromProject,
  loadMoreButton,
  emptyState,
  loadingIndicator,
}: ChatListProps) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null)
  const syncFailedChats = useSyncFailedChats()
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
    if (chat.decryptionFailed) {
      onEncryptionKeyClick?.()
      return
    }

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
      <div className="space-y-2 p-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'rounded-lg px-3 py-2',
              isDarkMode ? 'bg-surface-chat' : 'bg-white',
            )}
          >
            <Shimmer className="mb-2 h-4 w-3/4" />
            <Shimmer className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    )
  }

  // Chats that failed to decrypt are never displayed. They stay in
  // storage so the background re-decryption can recover them once the
  // right key is active, at which point they reappear here.
  const visibleChats = chats.filter((chat) => !chat.decryptionFailed)

  if (visibleChats.length === 0 && emptyState) {
    return (
      <div className="space-y-2 p-2">
        {loadingIndicator}
        <div className="p-2">{emptyState}</div>
      </div>
    )
  }

  const lastBlankIndex = visibleChats.reduce(
    (acc, chat, index) => (chat.isBlankChat ? index : acc),
    -1,
  )

  return (
    <>
      <div role="list" className="space-y-2 p-2">
        {lastBlankIndex < 0 && loadingIndicator}
        {visibleChats.map((chat, index) => (
          <Fragment key={getChatKey(chat)}>
            <div role="listitem" className="relative">
              <ChatListItem
                chat={chat}
                isSelected={isSelected(chat)}
                isEditing={editingChatId === chat.id}
                editingTitle={editingTitle}
                isDarkMode={isDarkMode}
                showEncryptionStatus={showEncryptionStatus}
                showSyncStatus={showSyncStatus}
                isStreaming={!chat.isBlankChat && chat.id === streamingChatId}
                syncFailed={Boolean(syncFailedChats[chat.id])}
                enableTitleAnimation={
                  enableTitleAnimation && manuallyEditedChatId !== chat.id
                }
                isDraggable={
                  isDraggable && !chat.isBlankChat && !chat.decryptionFailed
                }
                showMoveToProject={
                  showMoveToProject &&
                  !chat.isBlankChat &&
                  !chat.decryptionFailed
                }
                projects={projects}
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
            {index === lastBlankIndex && loadingIndicator}
          </Fragment>
        ))}
      </div>
      {loadMoreButton}
    </>
  )
}

export { type ChatItemData } from './chat-list-item'
