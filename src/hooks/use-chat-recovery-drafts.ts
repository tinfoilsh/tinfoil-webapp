import {
  getActiveChatRecoveryPhaseSnapshot,
  getActiveChatRecoverySnapshot,
  getChatRecoveryDraftSnapshot,
  subscribeChatRecoveryDrafts,
  type ChatRecoveryPhase,
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

export function useChatRecoveryPhases(
  chatId: string,
): ReadonlyArray<{ turnId: string; phase: ChatRecoveryPhase }> {
  const recoveries = useSyncExternalStore(
    subscribeChatRecoveryDrafts,
    getActiveChatRecoveryPhaseSnapshot,
    () => emptySnapshot,
  )
  return useMemo(() => {
    const prefix = `${chatId}\u0000`
    return recoveries.flatMap((recovery) =>
      recovery.key.startsWith(prefix)
        ? [
            {
              turnId: recovery.key.slice(prefix.length),
              phase: recovery.phase,
            },
          ]
        : [],
    )
  }, [chatId, recoveries])
}
