import {
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
