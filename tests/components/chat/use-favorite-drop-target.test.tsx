import { useFavoriteDropTarget } from '@/components/chat/use-favorite-drop-target'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function dragEvent(chatId: string) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    relatedTarget: null,
    currentTarget: document.createElement('div'),
    dataTransfer: {
      types: ['application/x-chat-id'],
      dropEffect: 'move',
      getData: vi.fn(() => chatId),
    },
  }
}

describe('useFavoriteDropTarget', () => {
  it('pins a dropped chat and clears drag state', async () => {
    const onToggleFavorite = vi.fn()
    const onActivate = vi.fn()
    const clearDragState = vi.fn()
    const { result } = renderHook(() =>
      useFavoriteDropTarget({
        chats: [{ id: 'chat-a', title: 'Chat A' }],
        pinnedChatIds: [],
        draggingChatId: 'chat-a',
        onToggleFavorite,
        onActivate,
        clearDragState,
      }),
    )
    const event = dragEvent('chat-a')

    act(() => result.current.favoriteDropTargetProps.onDragOver(event as never))
    expect(event.dataTransfer.dropEffect).toBe('copy')
    expect(result.current.isFavoriteDropTarget).toBe(true)
    expect(onActivate).toHaveBeenCalledOnce()

    await act(async () => {
      result.current.favoriteDropTargetProps.onDrop(event as never)
      await Promise.resolve()
    })

    expect(onToggleFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-a' }),
    )
    expect(clearDragState).toHaveBeenCalledOnce()
    expect(result.current.isFavoriteDropTarget).toBe(false)
  })

  it('does not toggle an already pinned chat', () => {
    const onToggleFavorite = vi.fn()
    const clearDragState = vi.fn()
    const { result } = renderHook(() =>
      useFavoriteDropTarget({
        chats: [{ id: 'chat-a', title: 'Chat A' }],
        pinnedChatIds: ['chat-a'],
        draggingChatId: 'chat-a',
        onToggleFavorite,
        clearDragState,
      }),
    )

    const event = dragEvent('chat-a')
    act(() => result.current.favoriteDropTargetProps.onDragOver(event as never))
    expect(result.current.isFavoriteDropTarget).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()

    act(() => result.current.favoriteDropTargetProps.onDrop(event as never))

    expect(onToggleFavorite).not.toHaveBeenCalled()
    expect(clearDragState).toHaveBeenCalledOnce()
  })

  it('activates once while a drag remains over the target', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() =>
      useFavoriteDropTarget({
        chats: [{ id: 'chat-a', title: 'Chat A' }],
        pinnedChatIds: [],
        draggingChatId: 'chat-a',
        onToggleFavorite: vi.fn(),
        onActivate,
        clearDragState: vi.fn(),
      }),
    )
    const event = dragEvent('chat-a')

    act(() =>
      result.current.favoriteDropTargetProps.onDragEnter(event as never),
    )
    act(() => result.current.favoriteDropTargetProps.onDragOver(event as never))

    expect(onActivate).toHaveBeenCalledOnce()
  })

  it('clears its highlight when dragging ends elsewhere', () => {
    const { result, rerender } = renderHook(
      ({ draggingChatId }: { draggingChatId: string | null }) =>
        useFavoriteDropTarget({
          chats: [{ id: 'chat-a', title: 'Chat A' }],
          pinnedChatIds: [],
          draggingChatId,
          onToggleFavorite: vi.fn(),
          clearDragState: vi.fn(),
        }),
      { initialProps: { draggingChatId: 'chat-a' as string | null } },
    )

    act(() =>
      result.current.favoriteDropTargetProps.onDragOver(
        dragEvent('chat-a') as never,
      ),
    )
    expect(result.current.isFavoriteDropTarget).toBe(true)

    rerender({ draggingChatId: null })
    expect(result.current.isFavoriteDropTarget).toBe(false)
  })

  it('does not highlight for an ineligible chat', () => {
    const onToggleFavorite = vi.fn()
    const clearDragState = vi.fn()
    const { result } = renderHook(() =>
      useFavoriteDropTarget({
        chats: [
          {
            id: 'chat-a',
            title: 'Chat A',
            isTemporary: true,
          },
        ],
        pinnedChatIds: [],
        draggingChatId: 'chat-a',
        onToggleFavorite,
        clearDragState,
      }),
    )
    const event = dragEvent('chat-a')

    act(() => result.current.favoriteDropTargetProps.onDragOver(event as never))

    expect(result.current.isFavoriteDropTarget).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()

    act(() => result.current.favoriteDropTargetProps.onDrop(event as never))
    expect(onToggleFavorite).not.toHaveBeenCalled()
    expect(clearDragState).toHaveBeenCalledOnce()
  })
})
