import {
  getActiveChatRecoverySnapshot,
  getChatRecoveryDraftSnapshot,
  subscribeChatRecoveryDrafts,
} from '@/services/inference/chat-recovery-drafts'
import { useMemo, useSyncExternalStore } from 'react'

const emptySnapshot = [] as const

export function useChatRecoveryDrafts(chatId: string) {
  const drafts = useSyncExternalStore(
    subscribeChatRecoveryDrafts,
    getChatRecoveryDraftSnapshot,
    () => emptySnapshot,
  )
  return useMemo(
    () => drafts.filter((draft) => draft.chatId === chatId),
    [chatId, drafts],
  )
}

export function useChatRecoveryActiveTurnIds(
  chatId: string,
): readonly string[] {
  const activeTurns = useSyncExternalStore(
    subscribeChatRecoveryDrafts,
    getActiveChatRecoverySnapshot,
    () => emptySnapshot,
  )
  return useMemo(() => {
    const prefix = `${chatId}\u0000`
    return activeTurns
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }, [activeTurns, chatId])
}

export function useChatRecoveryActive(chatId: string): boolean {
  return useChatRecoveryActiveTurnIds(chatId).length > 0
}
