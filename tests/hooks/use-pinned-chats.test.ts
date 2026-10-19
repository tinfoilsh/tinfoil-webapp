import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import {
  AUTH_ACTIVE_USER_ID,
  USER_PREFS_PINNED_CHAT_IDS,
} from '@/constants/storage-keys'
import { usePinnedChats } from '@/hooks/use-pinned-chats'
import { chatEvents } from '@/services/storage/chat-events'
import { savePinnedChatIds } from '@/services/storage/pinned-chats'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('usePinnedChats', () => {
  beforeEach(() => {
    localStorage.clear()
    chatEvents.clear()
  })

  it('prunes pins only after a confirmed delete event', () => {
    savePinnedChatIds(['chat-a', 'chat-b'])
    const { result } = renderHook(() => usePinnedChats())

    act(() => chatEvents.emit({ reason: 'sync', ids: ['chat-a'] }))
    expect(result.current.pinnedChatIds).toEqual(['chat-a', 'chat-b'])

    act(() => chatEvents.emit({ reason: 'delete', ids: ['chat-a'] }))
    expect(result.current.pinnedChatIds).toEqual(['chat-b'])
  })

  it('removes multiple confirmed ids atomically', () => {
    savePinnedChatIds(['chat-a', 'chat-b', 'chat-c'])
    const { result } = renderHook(() => usePinnedChats())

    act(() => result.current.unpinChats(['chat-a', 'chat-c']))

    expect(result.current.pinnedChatIds).toEqual(['chat-b'])
  })

  it('clears every pin only for an explicit delete-all event', () => {
    savePinnedChatIds(['chat-a', 'chat-b'])
    const { result } = renderHook(() => usePinnedChats())

    act(() => chatEvents.emit({ reason: 'delete', ids: [] }))
    expect(result.current.pinnedChatIds).toEqual(['chat-a', 'chat-b'])

    act(() => chatEvents.emit({ reason: 'delete-all' }))
    expect(result.current.pinnedChatIds).toEqual([])
  })

  it('does not expose or mutate pins from another active account', () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
    savePinnedChatIds(['chat-a'])

    const { result } = renderHook(() => usePinnedChats('user-b'))
    expect(result.current.pinnedChatIds).toEqual([])

    act(() => result.current.pinChat('chat-b'))
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user-a')
    expect(localStorage.getItem(USER_PREFS_PINNED_CHAT_IDS)).toBe('["chat-a"]')
  })

  it('exposes pins once the active account is established', () => {
    savePinnedChatIds(['chat-a'])

    const { result } = renderHook(() => usePinnedChats('user-a'))

    expect(result.current.pinnedChatIds).toEqual([])

    act(() => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
      window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    })

    expect(result.current.pinnedChatIds).toEqual(['chat-a'])
  })

  it('does not dispatch changes for no-op removals', () => {
    savePinnedChatIds([])
    const listener = vi.fn()
    window.addEventListener(PINNED_CHAT_IDS_CHANGED_EVENT, listener)
    const { result } = renderHook(() => usePinnedChats())
    listener.mockClear()

    act(() => result.current.unpinChat('chat-b'))
    act(() => chatEvents.emit({ reason: 'delete-all' }))

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(PINNED_CHAT_IDS_CHANGED_EVENT, listener)
  })
})
