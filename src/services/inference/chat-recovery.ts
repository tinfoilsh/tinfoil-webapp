import {
  finalizeInterruptedMessage,
  hasVisibleAssistantMessage,
  parseRichStreamingResponse,
} from '@/components/chat/hooks/streaming'
import type { Chat, Message } from '@/components/chat/types'
import { getKnownModelDisplayName } from '@/config/models'
import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { retryDeferredAlternativesFinalization } from '@/services/cloud/legacy-blob-migration'
import { encryptionService } from '@/services/encryption/encryption-service'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  RECOVERY_ENVELOPE_EXPIRY_MS,
  isLocalRecoveryEnvelope,
  samePendingRecoveryEnvelope,
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
  getChatRecoveryDraft,
  pruneChatRecoveryDrafts,
  setChatRecoveryActive,
  setChatRecoveryDraft,
} from './chat-recovery-drafts'
import {
  addPendingRecovery,
  completePendingRecovery,
  removePendingRecovery,
  replacePendingRecovery,
  resetChatRecoverySyncState,
  sameRecoveredResponse,
} from './chat-recovery-sync'
import { chatChunkStreamFromSSE } from './chat-stream'
import { generateTitle, getTitleContent } from './title'

type ActiveRecovery = {
  chatId: string
  turnId: string
  sessionId: string
  generation: number
  envelope?: PendingRecoveryEnvelope
}

type ScannedRecovery = {
  chatId: string
  turnId: string
  sessionId: string
  generation: number
  envelope: PendingRecoveryEnvelope
  controller: AbortController
}

const activeRecoveries = new Map<string, ActiveRecovery>()
const scannedRecoveries = new Map<string, ScannedRecovery>()
const cancelledTurns = new Set<string>()
const RECOVERY_SCAN_CONCURRENCY = 4
const RECOVERY_RETRY_BASE_DELAY_MS = 100
const RECOVERY_RETRY_MAX_DELAY_MS = 10_000
// Upper bound on how long a scan may make no progress while holding the
// dedupe slot. A stream wedged on a dead socket (e.g. after laptop sleep)
// would otherwise absorb every future scan and silently disable recovery
// for the rest of the session.
const RECOVERY_SCAN_MAX_AGE_MS = 120_000
let recoveryGeneration = 0
let recoveryScanGeneration = 0
let queuedScanUserId: string | null = null
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

async function recoveredTitlePatch(
  chatId: string,
  turnId: string,
  isCurrent: () => boolean,
): Promise<
  | {
      title: string
      titleState: 'generated'
      expectedTitleState: 'placeholder'
    }
  | undefined
> {
  const chat = await indexedDBStorage.getChat(chatId)
  if (!isCurrent() || chat?.titleState !== 'placeholder') return

  const firstUserMessage = chat.messages.find(
    (message) => message.role === 'user',
  )
  if (!firstUserMessage || firstUserMessage.turnId !== turnId) return

  const content = getTitleContent(firstUserMessage)
  const title = await generateTitle([{ role: 'user', content }])
  if (!isCurrent() || title === DEFAULT_CHAT_TITLE) return
  return {
    title,
    titleState: 'generated',
    expectedTitleState: 'placeholder',
  }
}

function waitForRecoveryRetry(
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const delay = Math.min(
    RECOVERY_RETRY_BASE_DELAY_MS * 2 ** attempt,
    RECOVERY_RETRY_MAX_DELAY_MS,
  )
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
  if (!active || !isCurrentAttempt() || cancelledTurns.has(key)) {
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
  // Re-check the cancelled set as well: a stop pressed while this token
  // capture was in flight marks the turn cancelled before the (later)
  // cancelChatRecovery call deregisters the attempt, so isCurrentAttempt
  // alone would still pass here and write an envelope for a stopped turn.
  if (!isCurrentAttempt() || cancelledTurns.has(key)) {
    await deleteRecoveryQuietly(args.sessionId)
    throw new DOMException('Aborted', 'AbortError')
  }
  await addPendingRecovery(args.chatId, envelope)

  if (!isCurrentAttempt()) {
    try {
      await removePendingRecovery(args.chatId, envelope)
    } finally {
      await deleteRecoveryQuietly(args.sessionId)
    }
    throw new DOMException('Aborted', 'AbortError')
  }
  active.envelope = envelope
  if (cancelledTurns.has(key)) {
    await Promise.all([
      removePendingRecovery(args.chatId, envelope, isCurrentAttempt),
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
      if (isCurrent() && active.envelope) {
        await removePendingRecovery(active.chatId, active.envelope, isCurrent)
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
}): Promise<Chat> {
  const active = [...activeRecoveries.values()].find(
    (candidate) =>
      candidate.chatId === args.chatId && candidate.turnId === args.turnId,
  )
  const isCurrent = () =>
    active?.generation === recoveryGeneration &&
    activeRecoveries.get(active.sessionId) === active
  if (!active?.envelope || !isCurrent()) {
    throw new DOMException('Aborted', 'AbortError')
  }
  const completedChat = await completePendingRecovery(
    args.chatId,
    active.envelope,
    args.assistantMessage,
    args.chatPatch,
    isCurrent,
  )
  activeRecoveries.delete(active.sessionId)
  await deleteRecoveryQuietly(active.sessionId)
  return {
    ...completedChat,
    createdAt: new Date(completedChat.createdAt),
    pendingSave: false,
    messages: completedChat.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    })),
  }
}

export async function cancelChatRecovery(
  chatId: string,
  assistantMessage?: Message,
  turnId?: string,
): Promise<boolean> {
  const targetTurnId = assistantMessage?.turnId ?? turnId
  const active = [...activeRecoveries.values()].filter(
    (candidate) =>
      candidate.chatId === chatId &&
      (targetTurnId === undefined || candidate.turnId === targetTurnId),
  )
  const scanned = [...scannedRecoveries.values()].filter(
    (candidate) =>
      candidate.chatId === chatId &&
      (targetTurnId === undefined || candidate.turnId === targetTurnId),
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
  const envelopeTurns = new Set(
    recoveries
      .filter((recovery) => recovery.envelope !== undefined)
      .map((recovery) => recovery.turnId),
  )
  await Promise.all(
    recoveries.map(async (recovery) => {
      const isCurrent = () => recovery.generation === recoveryGeneration
      if (!isCurrent()) return
      if (!recovery.envelope) {
        await deleteRecoveryQuietly(recovery.sessionId)
        return
      }

      const recoveryDraft = getChatRecoveryDraft(
        recovery.chatId,
        recovery.turnId,
      )
      const draftMessage =
        recoveryDraft?.sessionId === recovery.sessionId
          ? recoveryDraft.message
          : undefined
      const stoppedMessage =
        assistantMessage?.turnId === recovery.turnId
          ? assistantMessage
          : draftMessage

      if (stoppedMessage && hasVisibleAssistantMessage(stoppedMessage)) {
        const finalizedMessage = finalizeInterruptedMessage(
          stoppedMessage,
          recovery.turnId,
        )
        const completedChat = await completePendingRecovery(
          recovery.chatId,
          recovery.envelope,
          finalizedMessage,
          {},
          isCurrent,
        )
        const persisted = completedChat.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.turnId === recovery.turnId &&
            hasVisibleAssistantMessage(message),
        )
        if (persisted) await deleteRecoveryQuietly(recovery.sessionId)
      } else {
        try {
          await removePendingRecovery(
            recovery.chatId,
            recovery.envelope,
            isCurrent,
          )
        } finally {
          await deleteRecoveryQuietly(recovery.sessionId)
        }
      }
    }),
  )
  return assistantMessage?.turnId
    ? envelopeTurns.has(assistantMessage.turnId)
    : envelopeTurns.size > 0
}

/**
 * Mark a turn's recovery as cancelled before the async cancellation work
 * runs. Stopping a generation before the first token races the recovery
 * registration (the token is captured when response headers arrive):
 * without this early mark, an in-flight persistChatRecoveryToken would
 * still write its envelope, briefly surfacing the stopped turn as a
 * recoverable stream until the envelope removal round-trips.
 */
export function markChatRecoveryTurnCancelled(
  chatId: string,
  turnId: string,
): void {
  cancelledTurns.add(turnKey(chatId, turnId))
}

export function isChatRecoveryTurnCancelled(
  chatId: string,
  turnId: string,
): boolean {
  return cancelledTurns.has(turnKey(chatId, turnId))
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
      await removePendingRecovery(chatId, envelope, isCurrent, signal)
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
      !rewrappedChat.pendingRecoveries?.some((candidate) =>
        samePendingRecoveryEnvelope(candidate, rewrapped),
      )
    ) {
      return
    }
    envelope = rewrapped
  }
  const payload = opened.payload
  const initialStatus = await getChatRecoveryStatus(payload.sessionId)
  if (!isCurrent()) return
  const replacedRecoveryDeletions: Promise<void>[] = []
  for (const [sessionId, retained] of scannedRecoveries) {
    if (retained.chatId !== chatId || retained.turnId !== envelope.turnId) {
      continue
    }
    if (
      sessionId === payload.sessionId &&
      (initialStatus.state === 'processing' ||
        initialStatus.state === 'complete')
    ) {
      if (!retained.controller.signal.aborted) {
        return
      }
      scannedRecoveries.delete(sessionId)
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
      await removePendingRecovery(chatId, envelope, isCurrent, signal)
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
      await removePendingRecovery(chatId, envelope, isCurrent, signal)
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
    envelope,
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
  let highestEncryptedBytes = 0
  let highestPersistedBytes = initialStatus.persistedBytes
  const markRecoveryProgress = () => {
    if (scanInFlight?.controller.signal === signal) {
      scanInFlight.lastProgressAt = Date.now()
    }
  }
  const observePersistedBytes = (bytes: number) => {
    if (bytes <= highestPersistedBytes) return
    highestPersistedBytes = bytes
    markRecoveryProgress()
  }
  const publishDraft = (message: Message): Message | undefined => {
    if (!isRecoveryCurrent() || !hasVisibleRecoveryDraft(message)) {
      return undefined
    }
    const draftMessage: Message = {
      ...message,
      role: 'assistant',
      turnId: envelope.turnId,
    }
    setChatRecoveryDraft({
      chatId,
      turnId: envelope.turnId,
      sessionId: payload.sessionId,
      message: draftMessage,
    })
    return draftMessage
  }
  try {
    const storedChat = await indexedDBStorage.getChat(chatId)
    if (!isRecoveryCurrent()) return
    const fallbackModelDisplayName = storedChat?.model
      ? getKnownModelDisplayName(storedChat.model)
      : undefined
    const recoveryDraft = getChatRecoveryDraft(chatId, envelope.turnId)
    let presentationCheckpoint =
      recoveryDraft?.sessionId === payload.sessionId
        ? recoveryDraft.message
        : undefined
    if (!presentationCheckpoint) {
      presentationCheckpoint = (storedChat?.messages ?? []).find(
        (message) =>
          message.role === 'assistant' && message.turnId === envelope.turnId,
      )
    }
    let streamAttempt = 0
    while (isRecoveryCurrent()) {
      const attempt = streamAttempt++
      let consumedEncryptedBytes = 0
      let measuredEncryptedBytes = false
      let assistantMessage: Message
      const attemptCheckpoint = presentationCheckpoint
      let checkpointReached = !attemptCheckpoint
      try {
        const response = await fetchRecoveredChatResponse(
          payload.sessionId,
          recoveryTokenFromPayload(payload.recoveryToken),
          recoverySignal,
          (bytes) => {
            measuredEncryptedBytes = true
            consumedEncryptedBytes += bytes
            if (consumedEncryptedBytes > highestEncryptedBytes) {
              highestEncryptedBytes = consumedEncryptedBytes
              markRecoveryProgress()
            }
          },
        )
        if (!isRecoveryCurrent()) return
        if (!response.ok) {
          await response.arrayBuffer()
          if (!isRecoveryCurrent()) return
          try {
            await removePendingRecovery(
              chatId,
              envelope,
              isRecoveryCurrent,
              recoverySignal,
            )
          } finally {
            await deleteRecoveryQuietly(payload.sessionId)
          }
          return
        }
        assistantMessage = await parseRichStreamingResponse(
          chatChunkStreamFromSSE(response),
          {
            modelDisplayName: fallbackModelDisplayName,
            resolveModelDisplayName: getKnownModelDisplayName,
            onUpdate: (message) => {
              if (!isRecoveryCurrent()) return
              if (!checkpointReached && attemptCheckpoint) {
                checkpointReached = sameRecoveredResponse(
                  attemptCheckpoint,
                  message,
                )
                return
              }
              const published = publishDraft(message)
              if (
                published &&
                (!presentationCheckpoint ||
                  !sameRecoveredResponse(presentationCheckpoint, published))
              ) {
                presentationCheckpoint = published
                markRecoveryProgress()
              }
            },
          },
        )
      } catch {
        if (!isRecoveryCurrent()) return
        const retryStatus = await getChatRecoveryStatus(payload.sessionId)
        if (!isRecoveryCurrent()) return
        observePersistedBytes(retryStatus.persistedBytes)
        if (retryStatus.state === 'failed') {
          try {
            await removePendingRecovery(
              chatId,
              envelope,
              isRecoveryCurrent,
              recoverySignal,
            )
          } finally {
            await deleteRecoveryQuietly(payload.sessionId)
          }
          return
        }
        if (retryStatus.state === 'missing') {
          await removePendingRecovery(
            chatId,
            envelope,
            isRecoveryCurrent,
            recoverySignal,
          )
          return
        }
        await waitForRecoveryRetry(attempt, recoverySignal)
        continue
      }
      if (!isRecoveryCurrent()) return
      const terminalStatus = await getChatRecoveryStatus(payload.sessionId)
      if (!isRecoveryCurrent()) return
      observePersistedBytes(terminalStatus.persistedBytes)
      if (terminalStatus.state === 'processing') {
        await waitForRecoveryRetry(attempt, recoverySignal)
        continue
      }
      if (terminalStatus.state === 'failed') {
        try {
          await removePendingRecovery(
            chatId,
            envelope,
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
          envelope,
          isRecoveryCurrent,
          recoverySignal,
        )
        return
      }
      if (
        measuredEncryptedBytes &&
        consumedEncryptedBytes < terminalStatus.persistedBytes
      ) {
        await waitForRecoveryRetry(attempt, recoverySignal)
        continue
      }
      const titlePatch = await recoveredTitlePatch(
        chatId,
        envelope.turnId,
        isRecoveryCurrent,
      )
      if (!isRecoveryCurrent()) return
      await completePendingRecovery(
        chatId,
        envelope,
        {
          ...assistantMessage,
          turnId: envelope.turnId,
        },
        titlePatch,
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
    if (
      scannedRecoveries.get(payload.sessionId) === scannedRecovery &&
      isCurrent()
    ) {
      scannedRecoveries.delete(payload.sessionId)
      setChatRecoveryActive(chatId, envelope.turnId, false)
    }
    await Promise.all(replacedRecoveryDeletions)
  }
}

export function scanPendingChatRecoveries(
  userId: string,
  refreshPending = false,
): Promise<void> {
  if (
    scanInFlight?.userId === userId &&
    Date.now() - scanInFlight.lastProgressAt < RECOVERY_SCAN_MAX_AGE_MS
  ) {
    if (refreshPending) {
      queuedScanUserId = userId
    }
    return scanInFlight.promise
  }
  queuedScanUserId = null
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
                  candidate.envelope,
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
      if (queuedScanUserId === userId) {
        queuedScanUserId = null
        void scanPendingChatRecoveries(userId, true)
      }
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
  queuedScanUserId = null
  resetChatRecoverySyncState()
}
