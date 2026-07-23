import type { Message } from '@/components/chat/types'

export type ChatRecoveryDraft = {
  chatId: string
  turnId: string
  sessionId: string
  message: Message
}

export type ChatRecoveryPhase = 'replaying' | 'streaming'

export type ActiveChatRecovery = {
  key: string
  phase: ChatRecoveryPhase
}

type Listener = () => void

const drafts = new Map<string, ChatRecoveryDraft>()
const activeTurns = new Map<string, ChatRecoveryPhase>()
const listeners = new Set<Listener>()
let snapshot: readonly ChatRecoveryDraft[] = []
let activeSnapshot: readonly string[] = []
let activeRecoverySnapshot: readonly ActiveChatRecovery[] = []

function draftKey(chatId: string, turnId: string): string {
  return `${chatId}\u0000${turnId}`
}

function publish(): void {
  snapshot = [...drafts.values()]
  activeSnapshot = [...activeTurns.keys()]
  activeRecoverySnapshot = [...activeTurns].map(([key, phase]) => ({
    key,
    phase,
  }))
  listeners.forEach((listener) => listener())
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscribeChatRecoveryDrafts(listener: Listener): () => void {
  return subscribe(listener)
}

export function getChatRecoveryDraftSnapshot(): readonly ChatRecoveryDraft[] {
  return snapshot
}

export function getActiveChatRecoverySnapshot(): readonly string[] {
  return activeSnapshot
}

export function getActiveChatRecoveryPhaseSnapshot(): readonly ActiveChatRecovery[] {
  return activeRecoverySnapshot
}

export function setChatRecoveryActive(
  chatId: string,
  turnId: string,
  active: boolean,
): void {
  const key = draftKey(chatId, turnId)
  const changed = active ? !activeTurns.has(key) : activeTurns.has(key)
  if (!changed) return
  if (active) {
    activeTurns.set(key, 'replaying')
  } else {
    activeTurns.delete(key)
  }
  publish()
}

export function setChatRecoveryPhase(
  chatId: string,
  turnId: string,
  phase: ChatRecoveryPhase,
): void {
  const key = draftKey(chatId, turnId)
  if (!activeTurns.has(key) || activeTurns.get(key) === phase) return
  activeTurns.set(key, phase)
  publish()
}

export function setChatRecoveryDraft(draft: ChatRecoveryDraft): void {
  drafts.set(draftKey(draft.chatId, draft.turnId), draft)
  publish()
}

export function clearChatRecoveryDraft(sessionId: string): void {
  let changed = false
  for (const [key, draft] of drafts) {
    if (draft.sessionId === sessionId) {
      drafts.delete(key)
      changed = true
    }
  }
  if (changed) {
    publish()
  }
}

export function pruneChatRecoveryDrafts(
  pendingTurns: ReadonlySet<string>,
): void {
  let changed = false
  for (const key of drafts.keys()) {
    if (!pendingTurns.has(key)) {
      drafts.delete(key)
      changed = true
    }
  }
  if (changed) {
    publish()
  }
}

export function clearChatRecoveryDrafts(): void {
  if (drafts.size > 0) {
    drafts.clear()
    publish()
  }
}

export function clearActiveChatRecoveries(): void {
  if (activeTurns.size > 0) {
    activeTurns.clear()
    publish()
  }
}
