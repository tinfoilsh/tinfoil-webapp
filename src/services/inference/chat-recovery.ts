import { parseRichStreamingResponse } from '@/components/chat/hooks/streaming'
import type { Message } from '@/components/chat/types'
import { retryDeferredAlternativesFinalization } from '@/services/cloud/legacy-blob-migration'
import { encryptionService } from '@/services/encryption/encryption-service'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  RECOVERY_ENVELOPE_EXPIRY_MS,
  isLocalRecoveryEnvelope,
  type PendingRecoveryEnvelope,
  type SyncedRecoveryEnvelope,
} from '@/types/chat-recovery'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import {
  deserializeSessionRecoveryToken,
  serializeSessionRecoveryToken,
  type SessionRecoveryToken,
} from 'tinfoil'
import {
  ChatRecoveryError,
  deleteChatRecovery,
  fetchRecoveredChatResponse,
  getChatRecoveryStatus,
} from './chat-recovery-client'
import {
  decryptRecoveryEnvelope,
  encryptRecoveryEnvelope,
  rewrapRecoveryEnvelope,
} from './chat-recovery-crypto'
import {
  clearChatRecoveryDrafts,
  pruneChatRecoveryDrafts,
  setChatRecoveryDraft,
} from './chat-recovery-drafts'
import {
  addPendingRecovery,
  completePendingRecovery,
  removePendingRecovery,
  replacePendingRecovery,
  resetChatRecoverySyncState,
} from './chat-recovery-sync'

type ActiveRecovery = {
  chatId: string
  turnId: string
  sessionId: string
  generation: number
}

const activeRecoveries = new Map<string, ActiveRecovery>()
const cancelledTurns = new Set<string>()
const RECOVERY_SCAN_CONCURRENCY = 4
// Upper bound on how long a scan may make no progress while holding the
// dedupe slot. A stream wedged on a dead socket (e.g. after laptop sleep)
// would otherwise absorb every future scan and silently disable recovery
// for the rest of the session.
const RECOVERY_SCAN_MAX_AGE_MS = 120_000
let recoveryGeneration = 0
let recoveryScanGeneration = 0
let scanInFlight: {
  userId: string
  promise: Promise<void>
  lastProgressAt: number
  controller: AbortController
} | null = null

function turnKey(chatId: string, turnId: string): string {
  return `${chatId}\u0000${turnId}`
}

function hasVisibleRecoveryDraft(message: Message): boolean {
  return Boolean(
    message.content ||
    message.thoughts ||
    message.isThinking ||
    message.timeline?.length ||
    message.urlFetches?.length ||
    message.webSearch ||
    message.toolCalls?.length ||
    message.codeExecCalls?.length,
  )
}

function recoveryTokenFromPayload(
  payload: string | { exportedSecret: string; requestEnc: string },
): SessionRecoveryToken {
  return deserializeSessionRecoveryToken(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  )
}

function candidateCEKs(): Uint8Array[] {
  const candidates: Uint8Array[] = [encryptionService.getKeyBytesOrThrow()]
  for (const alternative of encryptionService.getStoredAlternatives()) {
    const bytes = encryptionService.getAlternativeKeyBytes(alternative)
    if (bytes) candidates.push(bytes)
  }
  return candidates
}

async function openEnvelope(
  userId: string,
  chatId: string,
  envelope: PendingRecoveryEnvelope,
  now?: number,
) {
  if (isLocalRecoveryEnvelope(envelope)) {
    return {
      cek: null,
      payload: {
        sessionId: envelope.sessionId,
        recoveryToken: envelope.recoveryToken,
      },
      usesPrimary: true,
    }
  }
  let lastError: unknown
  const candidates = candidateCEKs()
  for (let index = 0; index < candidates.length; index++) {
    const cek = candidates[index]
    try {
      const payload = await decryptRecoveryEnvelope({
        cek,
        userId,
        chatId,
        envelope,
        now,
      })
      return { cek, payload, usesPrimary: index === 0 }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('Unable to decrypt chat recovery envelope')
}

function isSyncedRecoveryEnvelope(
  envelope: PendingRecoveryEnvelope,
): envelope is SyncedRecoveryEnvelope {
  return !isLocalRecoveryEnvelope(envelope)
}

async function deleteRecoveryQuietly(sessionId: string): Promise<void> {
  try {
    await deleteChatRecovery(sessionId)
  } catch (error) {
    logError('Failed to delete encrypted response recovery session', error, {
      component: 'chat-recovery',
      action: 'deleteRecovery',
    })
  }
}

export function startChatRecoveryAttempt(
  chatId: string,
  turnId: string,
  sessionId: string,
): void {
  activeRecoveries.set(sessionId, {
    chatId,
    turnId,
    sessionId,
    generation: recoveryGeneration,
  })
}

export async function persistChatRecoveryToken(args: {
  userId: string
  chatId: string
  turnId: string
  sessionId: string
  token: SessionRecoveryToken
}): Promise<void> {
  const key = turnKey(args.chatId, args.turnId)
  const active = activeRecoveries.get(args.sessionId)
  const isCurrentAttempt = () =>
    active?.generation === recoveryGeneration &&
    active.chatId === args.chatId &&
    active.turnId === args.turnId &&
    activeRecoveries.get(args.sessionId) === active
  if (!isCurrentAttempt() || cancelledTurns.has(key)) {
    await deleteRecoveryQuietly(args.sessionId)
    throw new DOMException('Aborted', 'AbortError')
  }

  const recoveryToken = serializeSessionRecoveryToken(args.token)
  const chat = await indexedDBStorage.getChat(args.chatId)
  if (!chat) {
    await deleteRecoveryQuietly(args.sessionId)
    throw new Error('Chat recovery could not find the target chat')
  }
  const localOnly = chat.isLocalOnly || !isCloudSyncEnabled()
  const now = new Date()
  const envelope: PendingRecoveryEnvelope = localOnly
    ? {
        v: 1,
        storage: 'local',
        turnId: args.turnId,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + RECOVERY_ENVELOPE_EXPIRY_MS,
        ).toISOString(),
        sessionId: args.sessionId,
        recoveryToken,
      }
    : await encryptRecoveryEnvelope({
        cek: encryptionService.getKeyBytesOrThrow(),
        userId: args.userId,
        chatId: args.chatId,
        turnId: args.turnId,
        sessionId: args.sessionId,
        recoveryToken,
      })
  if (!isCurrentAttempt()) {
    await deleteRecoveryQuietly(args.sessionId)
    throw new DOMException('Aborted', 'AbortError')
  }
  await addPendingRecovery(args.chatId, envelope)

  if (!isCurrentAttempt()) {
    await deleteRecoveryQuietly(args.sessionId)
    throw new DOMException('Aborted', 'AbortError')
  }
  if (cancelledTurns.has(key)) {
    await Promise.all([
      removePendingRecovery(args.chatId, args.turnId, isCurrentAttempt),
      deleteRecoveryQuietly(args.sessionId),
    ])
    throw new DOMException('Aborted', 'AbortError')
  }
}

export async function abandonChatRecoveryAttempt(
  sessionId: string,
): Promise<void> {
  const active = activeRecoveries.get(sessionId)
  activeRecoveries.delete(sessionId)
  try {
    if (active) {
      const isCurrent = () => active.generation === recoveryGeneration
      if (isCurrent()) {
        await removePendingRecovery(active.chatId, active.turnId, isCurrent)
      }
    }
  } finally {
    await deleteRecoveryQuietly(sessionId)
  }
}

export async function completeLiveChatRecovery(args: {
  chatId: string
  turnId: string
  assistantMessage: Message
  chatPatch?: Parameters<typeof completePendingRecovery>[3]
}): Promise<void> {
  const active = [...activeRecoveries.values()].find(
    (candidate) =>
      candidate.chatId === args.chatId && candidate.turnId === args.turnId,
  )
  const isCurrent = () =>
    active?.generation === recoveryGeneration &&
    activeRecoveries.get(active.sessionId) === active
  if (!active || !isCurrent()) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await completePendingRecovery(
    args.chatId,
    args.turnId,
    args.assistantMessage,
    args.chatPatch,
    isCurrent,
  )
  activeRecoveries.delete(active.sessionId)
  await deleteRecoveryQuietly(active.sessionId)
}

export async function cancelChatRecovery(chatId: string): Promise<void> {
  const active = [...activeRecoveries.values()].filter(
    (candidate) => candidate.chatId === chatId,
  )
  for (const recovery of active) {
    cancelledTurns.add(turnKey(recovery.chatId, recovery.turnId))
    activeRecoveries.delete(recovery.sessionId)
  }
  try {
    await Promise.all(
      active.map((recovery) => {
        const isCurrent = () => recovery.generation === recoveryGeneration
        return isCurrent()
          ? removePendingRecovery(recovery.chatId, recovery.turnId, isCurrent)
          : undefined
      }),
    )
  } finally {
    await Promise.all(
      active.map((recovery) => deleteRecoveryQuietly(recovery.sessionId)),
    )
  }
}

export function releaseActiveChatRecovery(chatId: string): void {
  for (const recovery of activeRecoveries.values()) {
    if (recovery.chatId === chatId) {
      activeRecoveries.delete(recovery.sessionId)
    }
  }
}

async function processEnvelope(
  userId: string,
  chatId: string,
  envelope: PendingRecoveryEnvelope,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const isCurrent = () =>
    generation === recoveryScanGeneration && !signal.aborted
  if (!isCurrent()) return
  const key = turnKey(chatId, envelope.turnId)
  if (cancelledTurns.has(key)) return
  if (
    [...activeRecoveries.values()].some(
      (active) => active.chatId === chatId && active.turnId === envelope.turnId,
    )
  ) {
    return
  }

  if (Date.now() >= Date.parse(envelope.expiresAt)) {
    let sessionId: string | undefined
    try {
      const opened = await openEnvelope(
        userId,
        chatId,
        envelope,
        Date.parse(envelope.expiresAt) - 1,
      )
      if (!isCurrent()) return
      sessionId = opened.payload.sessionId
    } catch (error) {
      logError('Failed to clean up expired chat recovery session', error, {
        component: 'chat-recovery',
        action: 'cleanupExpiredRecovery',
        metadata: { chatId },
      })
    }
    if (!isCurrent()) return
    try {
      await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
    } finally {
      if (sessionId) {
        await deleteRecoveryQuietly(sessionId)
      }
    }
    return
  }

  const opened = await openEnvelope(userId, chatId, envelope)
  if (!isCurrent()) return
  if (!opened.usesPrimary && isSyncedRecoveryEnvelope(envelope)) {
    const rewrapped = await rewrapRecoveryEnvelope({
      envelope,
      userId,
      chatId,
      oldCek: opened.cek as Uint8Array,
      newCek: encryptionService.getKeyBytesOrThrow(),
    })
    if (!isCurrent()) return
    const rewrappedChat = await replacePendingRecovery(
      chatId,
      envelope,
      rewrapped,
      isCurrent,
      signal,
    )
    if (!isCurrent()) return
    if (
      !rewrappedChat.pendingRecoveries?.some(
        (candidate) =>
          isSyncedRecoveryEnvelope(candidate) &&
          candidate.turnId === rewrapped.turnId &&
          candidate.keyId === rewrapped.keyId &&
          candidate.ciphertext === rewrapped.ciphertext,
      )
    ) {
      return
    }
  }
  const payload = opened.payload
  const initialStatus = await getChatRecoveryStatus(payload.sessionId)
  if (!isCurrent()) return
  if (initialStatus.state === 'failed') {
    try {
      await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
    } finally {
      await deleteRecoveryQuietly(payload.sessionId)
    }
    return
  }
  if (initialStatus.state === 'missing') {
    await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
    return
  }

  let replayComplete = initialStatus.bytes === 0
  const response = await fetchRecoveredChatResponse(
    payload.sessionId,
    recoveryTokenFromPayload(payload.recoveryToken),
    signal,
    initialStatus.bytes,
    () => {
      replayComplete = true
    },
  )
  if (!isCurrent()) return
  const assistantMessage = await parseRichStreamingResponse(response, {
    onUpdate: (message) => {
      if (!isCurrent()) return
      if (scanInFlight?.controller.signal === signal) {
        scanInFlight.lastProgressAt = Date.now()
      }
      if (
        initialStatus.state !== 'processing' ||
        !replayComplete ||
        !hasVisibleRecoveryDraft(message)
      ) {
        return
      }
      setChatRecoveryDraft({
        chatId,
        turnId: envelope.turnId,
        sessionId: payload.sessionId,
        message: {
          ...message,
          role: 'assistant',
          turnId: envelope.turnId,
        },
      })
    },
  })
  if (!isCurrent()) return
  const terminalState = (await getChatRecoveryStatus(payload.sessionId)).state
  if (!isCurrent()) return
  if (terminalState !== 'complete') {
    if (terminalState === 'failed') {
      try {
        await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
      } finally {
        await deleteRecoveryQuietly(payload.sessionId)
      }
      return
    }
    if (terminalState === 'missing') {
      await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
      return
    }
    throw new ChatRecoveryError(
      'Encrypted response recovery stream ended before completion',
      'processing',
      true,
    )
  }
  await completePendingRecovery(
    chatId,
    envelope.turnId,
    {
      ...assistantMessage,
      turnId: envelope.turnId,
    },
    undefined,
    isCurrent,
    signal,
  )
  await deleteRecoveryQuietly(payload.sessionId)
}

export function scanPendingChatRecoveries(userId: string): Promise<void> {
  if (
    scanInFlight?.userId === userId &&
    Date.now() - scanInFlight.lastProgressAt < RECOVERY_SCAN_MAX_AGE_MS
  ) {
    return scanInFlight.promise
  }
  const generation = ++recoveryScanGeneration
  scanInFlight?.controller.abort()
  const controller = new AbortController()
  const promise = (async () => {
    try {
      const chats = await indexedDBStorage.getAllChats()
      if (generation !== recoveryScanGeneration) return
      const pending = chats.flatMap((chat) =>
        (chat.pendingRecoveries ?? []).map((envelope) => ({
          chatId: chat.id,
          envelope,
        })),
      )
      pruneChatRecoveryDrafts(
        new Set(
          pending.map((candidate) =>
            turnKey(candidate.chatId, candidate.envelope.turnId),
          ),
        ),
      )
      let nextIndex = 0
      const worker = async () => {
        while (
          generation === recoveryScanGeneration &&
          nextIndex < pending.length
        ) {
          const candidate = pending[nextIndex++]
          try {
            await processEnvelope(
              userId,
              candidate.chatId,
              candidate.envelope,
              generation,
              controller.signal,
            )
          } catch (error) {
            if (generation !== recoveryScanGeneration) return
            if (error instanceof ChatRecoveryError && !error.retryable) {
              if (error.state === 'failed' || error.state === 'missing') {
                await removePendingRecovery(
                  candidate.chatId,
                  candidate.envelope.turnId,
                  () => generation === recoveryScanGeneration,
                  controller.signal,
                )
              }
              continue
            }
            logError('Failed to recover encrypted chat response', error, {
              component: 'chat-recovery',
              action: 'scan',
              metadata: { chatId: candidate.chatId },
            })
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(RECOVERY_SCAN_CONCURRENCY, pending.length) },
          worker,
        ),
      )
    } finally {
      if (generation === recoveryScanGeneration) {
        await retryDeferredAlternativesFinalization()
      }
    }
  })()
  scanInFlight = {
    userId,
    promise,
    lastProgressAt: Date.now(),
    controller,
  }
  const clear = () => {
    if (scanInFlight?.promise === promise) {
      scanInFlight = null
    }
  }
  void promise.then(clear, clear)
  return promise
}

export function resetChatRecoveryState(): void {
  recoveryGeneration += 1
  recoveryScanGeneration += 1
  scanInFlight?.controller.abort()
  activeRecoveries.clear()
  cancelledTurns.clear()
  clearChatRecoveryDrafts()
  scanInFlight = null
  resetChatRecoverySyncState()
}
