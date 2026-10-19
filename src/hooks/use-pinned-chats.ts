import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import {
  AUTH_ACTIVE_USER_ID,
  USER_PREFS_PINNED_CHAT_IDS,
} from '@/constants/storage-keys'
import { chatEvents } from '@/services/storage/chat-events'
import {
  addPinnedChatId,
  loadPinnedChatIds,
  removePinnedChatIds,
  savePinnedChatIds,
} from '@/services/storage/pinned-chats'
import { useCallback, useEffect, useState } from 'react'

export function usePinnedChats(accountId?: string | null) {
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>(
    () => loadPinnedChatIds() ?? [],
  )

  const isCurrentAccount = useCallback(() => {
    if (!accountId) return true
    if (typeof window === 'undefined') return false
    const activeAccountId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
    return activeAccountId === accountId
  }, [accountId])

  useEffect(() => {
    const refresh = () =>
      setPinnedChatIds(isCurrentAccount() ? (loadPinnedChatIds() ?? []) : [])
    const handleStorage = (event: StorageEvent) => {
      if (event.key === USER_PREFS_PINNED_CHAT_IDS) refresh()
    }
    const unsubscribeChats = chatEvents.on((event) => {
      if (!isCurrentAccount()) return
      if (event.reason === 'delete-all') {
        const current = loadPinnedChatIds() ?? []
        if (current.length === 0) return
        savePinnedChatIds([])
        return
      }
      if (event.reason !== 'delete' || !event.ids?.length) return
      const current = loadPinnedChatIds() ?? []
      const next = removePinnedChatIds(current, event.ids)
      if (next.length !== current.length) savePinnedChatIds(next)
    })

    window.addEventListener(PINNED_CHAT_IDS_CHANGED_EVENT, refresh)
    window.addEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorage)
    refresh()
    return () => {
      unsubscribeChats()
      window.removeEventListener(PINNED_CHAT_IDS_CHANGED_EVENT, refresh)
      window.removeEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorage)
    }
  }, [isCurrentAccount])

  const pinChat = useCallback(
    (chatId: string) => {
      if (!isCurrentAccount()) return
      const current = loadPinnedChatIds() ?? []
      savePinnedChatIds(addPinnedChatId(current, chatId))
    },
    [isCurrentAccount],
  )

  const unpinChat = useCallback(
    (chatId: string) => {
      if (!isCurrentAccount()) return
      const current = loadPinnedChatIds() ?? []
      const next = removePinnedChatIds(current, [chatId])
      if (next.length !== current.length) savePinnedChatIds(next)
    },
    [isCurrentAccount],
  )

  const unpinChats = useCallback(
    (chatIds: readonly string[]) => {
      if (!isCurrentAccount()) return
      const current = loadPinnedChatIds() ?? []
      const next = removePinnedChatIds(current, chatIds)
      if (next.length !== current.length) savePinnedChatIds(next)
    },
    [isCurrentAccount],
  )

  return {
    pinnedChatIds: isCurrentAccount() ? pinnedChatIds : [],
    pinChat,
    unpinChat,
    unpinChats,
  }
}
