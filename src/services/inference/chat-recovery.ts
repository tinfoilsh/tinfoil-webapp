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
  clearActiveChatRecoveries,
  clearChatRecoveryDrafts,
  pruneChatRecoveryDrafts,
  setChatRecoveryActive,
  setChatRecoveryDraft,
  setChatRecoveryPhase,
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

type ScannedRecovery = {
  chatId: string
  turnId: string
  sessionId: string
  generation: number
  controller: AbortController
}

const activeRecoveries = new Map<string, ActiveRecovery>()
const scannedRecoveries = new Map<string, ScannedRecovery>()
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
  const scanned = [...scannedRecoveries.values()].filter(
    (candidate) => candidate.chatId === chatId,
  )
  for (const recovery of active) {
    cancelledTurns.add(turnKey(recovery.chatId, recovery.turnId))
    activeRecoveries.delete(recovery.sessionId)
  }
  for (const recovery of scanned) {
    cancelledTurns.add(turnKey(recovery.chatId, recovery.turnId))
    scannedRecoveries.delete(recovery.sessionId)
    recovery.controller.abort()
    setChatRecoveryActive(recovery.chatId, recovery.turnId, false)
  }
  const recoveries = [...active, ...scanned]
  try {
    await Promise.all(
      recoveries.map((recovery) => {
        const isCurrent = () => recovery.generation === recoveryGeneration
        return isCurrent()
          ? removePendingRecovery(recovery.chatId, recovery.turnId, isCurrent)
          : undefined
      }),
    )
  } finally {
    await Promise.all(
      recoveries.map((recovery) => deleteRecoveryQuietly(recovery.sessionId)),
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
  const key = turnKey(chatId, envelope.turnId)
  const isCurrent = () =>
    generation === recoveryScanGeneration &&
    !signal.aborted &&
    !cancelledTurns.has(key)
  if (!isCurrent()) return
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
  const replacedRecoveryDeletions: Promise<void>[] = []
  for (const [sessionId, retained] of scannedRecoveries) {
    if (retained.chatId !== chatId || retained.turnId !== envelope.turnId) {
      continue
    }
    scannedRecoveries.delete(sessionId)
    retained.controller.abort()
    setChatRecoveryActive(retained.chatId, retained.turnId, false)
    if (sessionId !== payload.sessionId) {
      replacedRecoveryDeletions.push(deleteRecoveryQuietly(sessionId))
    }
  }
  if (initialStatus.state === 'failed') {
    try {
      await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
    } finally {
      await Promise.all([
        deleteRecoveryQuietly(payload.sessionId),
        ...replacedRecoveryDeletions,
      ])
    }
    return
  }
  if (initialStatus.state === 'missing') {
    try {
      await removePendingRecovery(chatId, envelope.turnId, isCurrent, signal)
    } finally {
      await Promise.all(replacedRecoveryDeletions)
    }
    return
  }

  const recoveryController = new AbortController()
  const abortRecovery = () => recoveryController.abort(signal.reason)
  const scannedRecovery: ScannedRecovery = {
    chatId,
    turnId: envelope.turnId,
    sessionId: payload.sessionId,
    generation: recoveryGeneration,
    controller: recoveryController,
  }
  signal.addEventListener('abort', abortRecovery, { once: true })
  scannedRecoveries.set(payload.sessionId, scannedRecovery)
  setChatRecoveryActive(chatId, envelope.turnId, true)
  const recoverySignal = recoveryController.signal
  const isRecoveryCurrent = () =>
    isCurrent() &&
    !recoverySignal.aborted &&
    scannedRecoveries.get(payload.sessionId) === scannedRecovery
  const publishDraft = (message: Message) => {
    if (!isRecoveryCurrent() || !hasVisibleRecoveryDraft(message)) return
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
  }
  let keepRecoveryActive = false
  try {
    let replayBytes = initialStatus.bytes
    let retriedWithoutProgress = false
    let latestVisibleDraft: Message | null = null
    const prepareReconnect = (
      state: 'processing' | 'complete' | 'failed' | 'missing',
      consumedBytes: number,
    ) => {
      if (state !== 'processing' && state !== 'complete') {
        return false
      }
      if (consumedBytes <= replayBytes) {
        if (retriedWithoutProgress) {
          keepRecoveryActive = true
          throw new ChatRecoveryError(
            'Encrypted response recovery stream ended before completion',
            'processing',
            true,
          )
        }
        retriedWithoutProgress = true
      } else {
        retriedWithoutProgress = false
      }
      replayBytes = Math.max(replayBytes, consumedBytes)
      return true
    }
    while (isRecoveryCurrent()) {
      let replayComplete = replayBytes === 0
      let consumedEncryptedBytes = 0
      let measuredEncryptedBytes = false
      let assistantMessage: Message
      setChatRecoveryPhase(chatId, envelope.turnId, 'replaying')
      try {
        const response = await fetchRecoveredChatResponse(
          payload.sessionId,
          recoveryTokenFromPayload(payload.recoveryToken),
          recoverySignal,
          replayBytes,
          () => {
            if (!isRecoveryCurrent()) return
            replayComplete = true
            setChatRecoveryPhase(chatId, envelope.turnId, 'streaming')
            if (latestVisibleDraft) publishDraft(latestVisibleDraft)
          },
          (bytes) => {
            measuredEncryptedBytes = true
            consumedEncryptedBytes += bytes
          },
        )
        if (!isRecoveryCurrent()) return
        if (!response.ok) {
          await response.arrayBuffer()
          if (!isRecoveryCurrent()) return
          try {
            await removePendingRecovery(
              chatId,
              envelope.turnId,
              isRecoveryCurrent,
              recoverySignal,
            )
          } finally {
            await deleteRecoveryQuietly(payload.sessionId)
          }
          return
        }
        assistantMessage = await parseRichStreamingResponse(response, {
          onUpdate: (message) => {
            if (!isRecoveryCurrent()) return
            if (scanInFlight?.controller.signal === signal) {
              scanInFlight.lastProgressAt = Date.now()
            }
            if (
              initialStatus.state !== 'processing' ||
              !hasVisibleRecoveryDraft(message)
            ) {
              return
            }
            latestVisibleDraft = message
            if (!replayComplete) return
            publishDraft(message)
          },
        })
      } catch (error) {
        if (!isRecoveryCurrent()) return
        const retryStatus = await getChatRecoveryStatus(payload.sessionId)
        if (!isRecoveryCurrent()) return
        if (prepareReconnect(retryStatus.state, consumedEncryptedBytes)) {
          continue
        }
        throw error
      }
      if (!isRecoveryCurrent()) return
      const terminalStatus = await getChatRecoveryStatus(payload.sessionId)
      if (!isRecoveryCurrent()) return
      if (terminalStatus.state === 'processing') {
        prepareReconnect(terminalStatus.state, consumedEncryptedBytes)
        continue
      }
      if (terminalStatus.state === 'failed') {
        try {
          await removePendingRecovery(
            chatId,
            envelope.turnId,
            isRecoveryCurrent,
            recoverySignal,
          )
        } finally {
          await deleteRecoveryQuietly(payload.sessionId)
        }
        return
      }
      if (terminalStatus.state === 'missing') {
        await removePendingRecovery(
          chatId,
          envelope.turnId,
          isRecoveryCurrent,
          recoverySignal,
        )
        return
      }
      if (
        measuredEncryptedBytes &&
        consumedEncryptedBytes < terminalStatus.bytes
      ) {
        prepareReconnect(terminalStatus.state, consumedEncryptedBytes)
        continue
      }
      await completePendingRecovery(
        chatId,
        envelope.turnId,
        {
          ...assistantMessage,
          turnId: envelope.turnId,
        },
        undefined,
        isRecoveryCurrent,
        recoverySignal,
      )
      if (scannedRecoveries.get(payload.sessionId) === scannedRecovery) {
        scannedRecoveries.delete(payload.sessionId)
        setChatRecoveryActive(chatId, envelope.turnId, false)
      }
      await deleteRecoveryQuietly(payload.sessionId)
      return
    }
  } finally {
    signal.removeEventListener('abort', abortRecovery)
    if (scannedRecoveries.get(payload.sessionId) === scannedRecovery) {
      if (!keepRecoveryActive) {
        scannedRecoveries.delete(payload.sessionId)
        setChatRecoveryActive(chatId, envelope.turnId, false)
      }
    }
    await Promise.all(replacedRecoveryDeletions)
  }
}

export function scanPendingChatRecoveries(
  userId: string,
  refreshPending = false,
): Promise<void> {
  if (
    !refreshPending &&
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
      const pendingTurnKeys = new Set(
        pending.map((candidate) =>
          turnKey(candidate.chatId, candidate.envelope.turnId),
        ),
      )
      const orphanedRecoveryDeletions: Promise<void>[] = []
      for (const [sessionId, retained] of scannedRecoveries) {
        if (pendingTurnKeys.has(turnKey(retained.chatId, retained.turnId))) {
          continue
        }
        scannedRecoveries.delete(sessionId)
        retained.controller.abort()
        setChatRecoveryActive(retained.chatId, retained.turnId, false)
        orphanedRecoveryDeletions.push(deleteRecoveryQuietly(sessionId))
      }
      pruneChatRecoveryDrafts(pendingTurnKeys)
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
            if (
              cancelledTurns.has(
                turnKey(candidate.chatId, candidate.envelope.turnId),
              ) ||
              (error instanceof DOMException && error.name === 'AbortError')
            ) {
              continue
            }
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
      await Promise.all([
        ...Array.from(
          { length: Math.min(RECOVERY_SCAN_CONCURRENCY, pending.length) },
          worker,
        ),
        ...orphanedRecoveryDeletions,
      ])
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
  for (const recovery of scannedRecoveries.values()) {
    recovery.controller.abort()
  }
  activeRecoveries.clear()
  scannedRecoveries.clear()
  cancelledTurns.clear()
  clearChatRecoveryDrafts()
  clearActiveChatRecoveries()
  scanInFlight = null
  resetChatRecoverySyncState()
}
