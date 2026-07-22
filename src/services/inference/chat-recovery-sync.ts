import type { Message } from '@/components/chat/types'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { nextClock } from '@/services/cloud/edit-clock'
import { remoteWins, trustedChatClock } from '@/services/cloud/sync-predicates'
import { chatEvents } from '@/services/storage/chat-events'
import {
  indexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { decideRecovery } from '@/services/sync-enclave'
import { newIdempotencyKey } from '@/services/sync-enclave/sync-api'
import {
  MAX_PENDING_RECOVERIES_PER_CHAT,
  type PendingRecoveryEnvelope,
} from '@/types/chat-recovery'

const RECOVERY_MUTATION_MAX_ATTEMPTS = 3

type ChatMutation = (chat: StoredChat) => { chat: StoredChat; changed: boolean }

const mutationTails = new Map<string, Promise<unknown>>()
let mutationGeneration = 0

function enqueueMutation<T>(chatId: string, operation: () => Promise<T>) {
  const generation = mutationGeneration
  const previous = mutationTails.get(chatId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => {
      if (generation !== mutationGeneration) {
        throw new DOMException('Aborted', 'AbortError')
      }
      return operation()
    })
  mutationTails.set(chatId, current)
  void current.then(
    () => {
      if (mutationTails.get(chatId) === current) {
        mutationTails.delete(chatId)
      }
    },
    () => {
      if (mutationTails.get(chatId) === current) {
        mutationTails.delete(chatId)
      }
    },
  )
  return current
}

function isSyncConflict(error: unknown): boolean {
  return decideRecovery(error).action.type === 'surface-conflict'
}

async function mutateSyncedChat(
  chatId: string,
  mutation: ChatMutation,
  isCurrent: () => boolean = () => true,
): Promise<StoredChat> {
  const generation = mutationGeneration
  const mutationIsCurrent = () =>
    generation === mutationGeneration && isCurrent()
  return enqueueMutation(chatId, async () => {
    for (let attempt = 0; attempt < RECOVERY_MUTATION_MAX_ATTEMPTS; attempt++) {
      if (!mutationIsCurrent()) {
        throw new DOMException('Aborted', 'AbortError')
      }
      const [remote, local] = await Promise.all([
        cloudStorage.downloadChat(chatId),
        indexedDBStorage.getChat(chatId),
      ])
      if (!mutationIsCurrent()) {
        throw new DOMException('Aborted', 'AbortError')
      }
      let base = remote ?? local
      if (!base) {
        throw new Error('Chat recovery could not find the target chat')
      }
      if (
        remote &&
        local?.locallyModified &&
        !remoteWins({
          localClock: trustedChatClock(local),
          remoteClock: trustedChatClock(remote),
          localUpdatedAt: local.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
        })
      ) {
        base = {
          ...local,
          syncVersion: remote.syncVersion,
        }
      }

      const result = mutation(base)
      if (!result.changed) {
        if (remote && base === remote && local !== remote) {
          const syncVersion = remote.syncVersion ?? 0
          const applied = await indexedDBStorage.applyRemoteChatIfFresh({
            chat: remote,
            syncVersion,
            expectedLocalUpdatedAt: local?.updatedAt ?? null,
            allowLocallyModified: true,
            isCurrent: mutationIsCurrent,
          })
          if (!applied.applied) {
            continue
          }
          chatEvents.emit({ reason: 'recovery', ids: [chatId] })
        }
        return result.chat
      }

      const clock = nextClock(base.clock)
      const nextChat: StoredChat = {
        ...result.chat,
        updatedAt: new Date().toISOString(),
        clock: clock.v,
        writer: clock.w,
        clockVersion: (base.syncVersion ?? 0) + 1,
        syncVersion: base.syncVersion ?? 0,
      }

      try {
        if (!mutationIsCurrent()) {
          throw new DOMException('Aborted', 'AbortError')
        }
        const uploaded = await cloudStorage.uploadChat(nextChat, {
          idempotencyKey: newIdempotencyKey(),
        })
        if (!mutationIsCurrent()) {
          throw new DOMException('Aborted', 'AbortError')
        }
        const syncVersion = uploaded.syncVersion ?? (base.syncVersion ?? 0) + 1
        const syncedChat: StoredChat = {
          ...nextChat,
          syncVersion,
          clockVersion: syncVersion,
          syncedAt: Date.now(),
          locallyModified: false,
        }
        const applied = await indexedDBStorage.applyRemoteChatIfFresh({
          chat: syncedChat,
          syncVersion,
          expectedLocalUpdatedAt: local?.updatedAt ?? null,
          allowLocallyModified: true,
          isCurrent: mutationIsCurrent,
        })
        if (applied.applied) {
          chatEvents.emit({ reason: 'recovery', ids: [chatId] })
          return syncedChat
        }
        continue
      } catch (error) {
        if (!isSyncConflict(error)) {
          throw error
        }
      }
    }
    throw new Error('Chat recovery could not resolve a sync conflict')
  })
}

export function resetChatRecoverySyncState(): void {
  mutationGeneration += 1
  mutationTails.clear()
}

export function addPendingRecovery(
  chatId: string,
  envelope: PendingRecoveryEnvelope,
): Promise<StoredChat> {
  return mutateSyncedChat(chatId, (chat) => {
    const existing = chat.pendingRecoveries ?? []
    const pending = existing.filter(
      (candidate) => candidate.turnId !== envelope.turnId,
    )
    if (
      pending.length >= MAX_PENDING_RECOVERIES_PER_CHAT &&
      pending.length === existing.length
    ) {
      throw new Error('Chat has too many pending recovery sessions')
    }
    pending.push(envelope)
    return {
      chat: { ...chat, pendingRecoveries: pending },
      changed: true,
    }
  })
}

export function replacePendingRecovery(
  chatId: string,
  current: PendingRecoveryEnvelope,
  replacement: PendingRecoveryEnvelope,
): Promise<StoredChat> {
  return mutateSyncedChat(chatId, (chat) => {
    const pending = chat.pendingRecoveries ?? []
    const index = pending.findIndex(
      (envelope) =>
        envelope.turnId === current.turnId &&
        envelope.keyId === current.keyId &&
        envelope.ciphertext === current.ciphertext,
    )
    if (index < 0) {
      return { chat, changed: false }
    }
    const next = [...pending]
    next[index] = replacement
    return {
      chat: { ...chat, pendingRecoveries: next },
      changed: true,
    }
  })
}

export function removePendingRecovery(
  chatId: string,
  turnId: string,
  isCurrent?: () => boolean,
): Promise<StoredChat> {
  return mutateSyncedChat(
    chatId,
    (chat) => {
      const pending = chat.pendingRecoveries ?? []
      const next = pending.filter((envelope) => envelope.turnId !== turnId)
      if (next.length === pending.length) {
        return { chat, changed: false }
      }
      return {
        chat: {
          ...chat,
          pendingRecoveries: next.length > 0 ? next : undefined,
        },
        changed: true,
      }
    },
    isCurrent,
  )
}

function sameRecoveredResponse(existing: Message, recovered: Message): boolean {
  const snapshot = (message: Message) =>
    JSON.stringify({
      content: message.content,
      thoughts: message.thoughts ?? null,
      isThinking: message.isThinking ?? false,
      thinkingDuration: message.thinkingDuration ?? null,
      webSearch: message.webSearch ?? null,
      urlFetches: message.urlFetches ?? null,
      annotations: message.annotations ?? null,
      timeline: message.timeline ?? null,
      toolCalls: message.toolCalls ?? null,
      codeExecCalls: message.codeExecCalls ?? null,
    })
  return snapshot(existing) === snapshot(recovered)
}

export function completePendingRecovery(
  chatId: string,
  turnId: string,
  assistantMessage: Message,
  chatPatch: Partial<
    Pick<StoredChat, 'title' | 'titleState' | 'model' | 'projectId'>
  > = {},
  isCurrent?: () => boolean,
): Promise<StoredChat> {
  return mutateSyncedChat(
    chatId,
    (chat) => {
      const currentPending = chat.pendingRecoveries ?? []
      const hasPending = currentPending.some(
        (envelope) => envelope.turnId === turnId,
      )
      const pending = currentPending.filter(
        (envelope) => envelope.turnId !== turnId,
      )
      const assistantIndex = chat.messages.findIndex(
        (message) => message.role === 'assistant' && message.turnId === turnId,
      )
      const hasAssistant = assistantIndex >= 0
      if (!hasPending && !hasAssistant) {
        return { chat, changed: false }
      }
      const recoveredMessage: Message = {
        ...assistantMessage,
        role: 'assistant',
        turnId,
      }
      let messages = chat.messages
      let messagesChanged = false
      if (!hasAssistant) {
        // Insert after the originating user turn, or append when the user
        // message has not reached this copy of the chat yet. Throwing here
        // would leave the envelope stuck in a permanent retry loop.
        const userIndex = chat.messages.findIndex(
          (message) => message.role === 'user' && message.turnId === turnId,
        )
        const insertAt = userIndex >= 0 ? userIndex + 1 : chat.messages.length
        messages = [
          ...chat.messages.slice(0, insertAt),
          recoveredMessage,
          ...chat.messages.slice(insertAt),
        ]
        messagesChanged = true
      } else if (
        hasPending &&
        !sameRecoveredResponse(chat.messages[assistantIndex], recoveredMessage)
      ) {
        // An assistant message with this turnId may be a partial persisted
        // before the stream was interrupted; the recovered response is the
        // complete one, so it wins.
        messages = [...chat.messages]
        messages[assistantIndex] = recoveredMessage
        messagesChanged = true
      }
      const patchChanged = Object.entries(chatPatch).some(
        ([key, value]) => chat[key as keyof StoredChat] !== value,
      )
      return {
        chat: {
          ...chat,
          ...chatPatch,
          messages,
          pendingRecoveries: pending.length > 0 ? pending : undefined,
        },
        changed:
          messagesChanged ||
          pending.length !== currentPending.length ||
          patchChanged,
      }
    },
    isCurrent,
  )
}
