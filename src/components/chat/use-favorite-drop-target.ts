import { canRequestChatPin } from '@/services/storage/pinned-chats'
import { logError } from '@/utils/error-handling'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEventHandler,
} from 'react'
import type { ChatItemData } from './chat-list-item'

interface FavoriteDropTargetOptions {
  chats: readonly ChatItemData[]
  pinnedChatIds: readonly string[]
  draggingChatId: string | null
  onToggleFavorite?: (chat: ChatItemData) => void | Promise<void>
  onActivate?: () => void
  clearDragState: () => void
}

export function useFavoriteDropTarget({
  chats,
  pinnedChatIds,
  draggingChatId,
  onToggleFavorite,
  onActivate,
  clearDragState,
}: FavoriteDropTargetOptions) {
  const [isFavoriteDropTarget, setIsFavoriteDropTarget] = useState(false)
  const draggedChat = useMemo(
    () => chats.find((chat) => chat.id === draggingChatId),
    [chats, draggingChatId],
  )
  const canAcceptDraggedChat = Boolean(
    draggedChat &&
    onToggleFavorite &&
    !pinnedChatIds.includes(draggedChat.id) &&
    canRequestChatPin(draggedChat),
  )

  useEffect(() => {
    if (!canAcceptDraggedChat) setIsFavoriteDropTarget(false)
  }, [canAcceptDraggedChat])

  const activateDropTarget = useCallback<DragEventHandler<HTMLElement>>(
    (event) => {
      if (
        !canAcceptDraggedChat ||
        !event.dataTransfer.types.includes('application/x-chat-id')
      ) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (!isFavoriteDropTarget) onActivate?.()
      setIsFavoriteDropTarget(true)
    },
    [canAcceptDraggedChat, isFavoriteDropTarget, onActivate],
  )

  const onDragLeave = useCallback<DragEventHandler<HTMLElement>>((event) => {
    const nextTarget = event.relatedTarget
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return
    }
    setIsFavoriteDropTarget(false)
  }, [])

  const onDrop = useCallback<DragEventHandler<HTMLElement>>(
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      setIsFavoriteDropTarget(false)
      const chatId = event.dataTransfer.getData('application/x-chat-id')
      const chat = chats.find((candidate) => candidate.id === chatId)
      if (
        !chat ||
        !canRequestChatPin(chat) ||
        pinnedChatIds.includes(chatId) ||
        !onToggleFavorite
      ) {
        clearDragState()
        return
      }
      clearDragState()
      const toggleFavorite = async () => {
        try {
          await onToggleFavorite(chat)
        } catch (error) {
          logError('Failed to pin dropped chat', error, {
            component: 'FavoriteDropTarget',
            action: 'dropChat',
            metadata: { chatId },
          })
        }
      }
      void toggleFavorite()
    },
    [chats, clearDragState, onToggleFavorite, pinnedChatIds],
  )

  return {
    isFavoriteDropTarget,
    favoriteDropTargetProps: {
      onDragOver: activateDropTarget,
      onDragEnter: activateDropTarget,
      onDragLeave,
      onDrop,
    },
  }
}
