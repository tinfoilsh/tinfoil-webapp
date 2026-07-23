import type { PendingRecoveryEnvelope } from '@/components/chat/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const decryptRecoveryEnvelope = vi.fn()
const encryptRecoveryEnvelope = vi.fn()
const rewrapRecoveryEnvelope = vi.fn()
const deleteChatRecovery = vi.fn()
const fetchRecoveredChatResponse = vi.fn()
const getChatRecoveryState = vi.fn()
const addPendingRecovery = vi.fn()
const completePendingRecovery = vi.fn()
const removePendingRecovery = vi.fn()
const replacePendingRecovery = vi.fn()
const resetChatRecoverySyncState = vi.fn()
const clearChatRecoveryDrafts = vi.fn()
const pruneChatRecoveryDrafts = vi.fn()
const setChatRecoveryDraft = vi.fn()
const retryDeferredAlternativesFinalization = vi.fn()
const parseRichStreamingResponse = vi.fn()
const getAllChats = vi.fn()
let storedAlternatives: string[] = []

vi.mock('@/services/inference/chat-recovery-crypto', () => ({
  decryptRecoveryEnvelope: (...args: unknown[]) =>
    decryptRecoveryEnvelope(...args),
  encryptRecoveryEnvelope: (...args: unknown[]) =>
    encryptRecoveryEnvelope(...args),
  rewrapRecoveryEnvelope: (...args: unknown[]) =>
    rewrapRecoveryEnvelope(...args),
}))

vi.mock('@/services/inference/chat-recovery-client', () => ({
  ChatRecoveryError: class ChatRecoveryError extends Error {
    constructor(
      message: string,
      public readonly state?: string,
      public readonly retryable = false,
    ) {
      super(message)
    }
  },
  deleteChatRecovery: (...args: unknown[]) => deleteChatRecovery(...args),
  fetchRecoveredChatResponse: (...args: unknown[]) =>
    fetchRecoveredChatResponse(...args),
  getChatRecoveryStatus: async (...args: unknown[]) => ({
    state: await getChatRecoveryState(...args),
    bytes: 128,
  }),
}))

vi.mock('@/services/inference/chat-recovery-sync', () => ({
  addPendingRecovery: (...args: unknown[]) => addPendingRecovery(...args),
  completePendingRecovery: (...args: unknown[]) =>
    completePendingRecovery(...args),
  removePendingRecovery: (...args: unknown[]) => removePendingRecovery(...args),
  replacePendingRecovery: (...args: unknown[]) =>
    replacePendingRecovery(...args),
  resetChatRecoverySyncState: () => resetChatRecoverySyncState(),
}))

vi.mock('@/services/inference/chat-recovery-drafts', () => ({
  clearChatRecoveryDrafts: () => clearChatRecoveryDrafts(),
  pruneChatRecoveryDrafts: (...args: unknown[]) =>
    pruneChatRecoveryDrafts(...args),
  setChatRecoveryDraft: (...args: unknown[]) => setChatRecoveryDraft(...args),
}))

vi.mock('@/services/cloud/legacy-blob-migration', () => ({
  retryDeferredAlternativesFinalization: () =>
    retryDeferredAlternativesFinalization(),
}))

vi.mock('@/components/chat/hooks/streaming', () => ({
  parseRichStreamingResponse: (...args: unknown[]) =>
    parseRichStreamingResponse(...args),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKeyBytesOrThrow: () => new Uint8Array(32),
    getStoredAlternatives: () => storedAlternatives,
    getAlternativeKeyBytes: () => new Uint8Array(32).fill(1),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getAllChats: () => getAllChats(),
  },
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

import {
  abandonChatRecoveryAttempt,
  cancelChatRecovery,
  persistChatRecoveryToken,
  resetChatRecoveryState,
  scanPendingChatRecoveries,
  startChatRecoveryAttempt,
} from '@/services/inference/chat-recovery'

const SESSION_ID = '0123456789abcdef0123456789abcdef'
const RECOVERY_SCAN_MAX_AGE_MS = 120_000
const envelope: PendingRecoveryEnvelope = {
  v: 1,
  turnId: 'turn-1',
  keyId: '0123456789abcdef0123456789abcdef',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA',
}

describe('chat recovery lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatRecoveryState()
    storedAlternatives = []
    deleteChatRecovery.mockResolvedValue(undefined)
    removePendingRecovery.mockResolvedValue(undefined)
    addPendingRecovery.mockResolvedValue(undefined)
    completePendingRecovery.mockResolvedValue(undefined)
    replacePendingRecovery.mockResolvedValue(undefined)
    retryDeferredAlternativesFinalization.mockResolvedValue(undefined)
  })

  it('suppresses a token that arrives after explicit cancellation', async () => {
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
    const cancellation = cancelChatRecovery('chat-1')

    await expect(
      persistChatRecoveryToken({
        userId: 'user-1',
        chatId: 'chat-1',
        turnId: 'turn-1',
        sessionId: SESSION_ID,
        token: {
          exportedSecret: new Uint8Array(32),
          requestEnc: new Uint8Array(32),
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await cancellation

    expect(encryptRecoveryEnvelope).not.toHaveBeenCalled()
    expect(addPendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('streams a processing session and persists only after completion', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockImplementation(
      async (
        _sessionId: string,
        _token: unknown,
        _signal: AbortSignal,
        _replayBytes: number,
        onReplayComplete: () => void,
      ) => {
        onReplayComplete()
        return new Response('stream')
      },
    )
    parseRichStreamingResponse.mockImplementation(
      async (
        _response: Response,
        options: { onUpdate: (message: object) => void },
      ) => {
        options.onUpdate({
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
        })
        options.onUpdate({
          role: 'assistant',
          content: 'Recover',
          timestamp: new Date().toISOString(),
        })
        expect(completePendingRecovery).not.toHaveBeenCalled()
        return {
          role: 'assistant',
          content: 'Recovered',
          timestamp: new Date().toISOString(),
        }
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(Object),
      expect.any(AbortSignal),
      128,
      expect.any(Function),
    )
    expect(setChatRecoveryDraft).toHaveBeenCalledWith({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: SESSION_ID,
      message: expect.objectContaining({
        role: 'assistant',
        content: 'Recover',
        turnId: 'turn-1',
      }),
    })
    expect(setChatRecoveryDraft).toHaveBeenCalledTimes(1)

    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      expect.objectContaining({
        role: 'assistant',
        content: 'Recovered',
        turnId: 'turn-1',
      }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('does not persist a stream that ends before the session is complete', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('processing')
    fetchRecoveredChatResponse.mockImplementation(
      async (
        _sessionId: string,
        _token: unknown,
        _signal: AbortSignal,
        _replayBytes: number,
        onReplayComplete: () => void,
      ) => {
        onReplayComplete()
        return new Response('stream')
      },
    )
    parseRichStreamingResponse.mockImplementation(
      async (
        _response: Response,
        options: { onUpdate: (message: object) => void },
      ) => {
        const message = {
          role: 'assistant',
          content: 'Partial',
          timestamp: new Date().toISOString(),
        }
        options.onUpdate(message)
        return message
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(setChatRecoveryDraft).toHaveBeenCalled()
    expect(completePendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).not.toHaveBeenCalled()
  })

  it('does not replay a completed response through progressive drafts', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockImplementation(
      async (
        _response: Response,
        options: { onUpdate: (message: object) => void },
      ) => {
        options.onUpdate({
          role: 'assistant',
          content: 'Replay prefix',
          timestamp: new Date().toISOString(),
        })
        return {
          role: 'assistant',
          content: 'Recovered',
          timestamp: new Date().toISOString(),
        }
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(setChatRecoveryDraft).not.toHaveBeenCalled()
    expect(completePendingRecovery).toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('stops an old account scan when recovery state is reset', async () => {
    let resolveChats: ((chats: unknown[]) => void) | undefined
    getAllChats.mockReturnValueOnce(
      new Promise<unknown[]>((resolve) => {
        resolveChats = resolve
      }),
    )
    const oldScan = scanPendingChatRecoveries('old-user')

    resetChatRecoveryState()
    resolveChats?.([{ id: 'chat-1', pendingRecoveries: [envelope] }])
    await oldScan

    expect(decryptRecoveryEnvelope).not.toHaveBeenCalled()
    getAllChats.mockResolvedValueOnce([])
    await expect(scanPendingChatRecoveries('new-user')).resolves.toBeUndefined()
  })

  it('aborts an aged scan before starting its replacement', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Recovered',
      timestamp: new Date().toISOString(),
    })
    let firstSignal: AbortSignal | undefined
    completePendingRecovery.mockImplementationOnce((...args: unknown[]) => {
      firstSignal = args[5] as AbortSignal
      return new Promise<void>((_resolve, reject) => {
        firstSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    })

    const oldScan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(completePendingRecovery).toHaveBeenCalledTimes(1),
    )

    now += RECOVERY_SCAN_MAX_AGE_MS
    const replacement = scanPendingChatRecoveries('user-1')

    await expect(replacement).resolves.toBeUndefined()
    await expect(oldScan).resolves.toBeUndefined()
    expect(firstSignal?.aborted).toBe(true)
    expect(completePendingRecovery).toHaveBeenCalledTimes(2)
    expect(completePendingRecovery.mock.calls[1][5]).toBeInstanceOf(AbortSignal)
    expect(completePendingRecovery.mock.calls[1][5].aborted).toBe(false)
    dateNow.mockRestore()
  })

  it('does not invalidate a live attempt when a recovery scan starts', async () => {
    getAllChats.mockResolvedValue([])
    encryptRecoveryEnvelope.mockResolvedValue(envelope)
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)

    await scanPendingChatRecoveries('user-1')
    await persistChatRecoveryToken({
      userId: 'user-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: SESSION_ID,
      token: {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32),
      },
    })

    expect(addPendingRecovery).toHaveBeenCalledWith('chat-1', envelope)
  })

  it('rejects token persistence after the account generation changes', async () => {
    let finishEncryption: ((value: PendingRecoveryEnvelope) => void) | undefined
    encryptRecoveryEnvelope.mockReturnValueOnce(
      new Promise<PendingRecoveryEnvelope>((resolve) => {
        finishEncryption = resolve
      }),
    )
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
    const persistence = persistChatRecoveryToken({
      userId: 'user-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: SESSION_ID,
      token: {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32),
      },
    })

    resetChatRecoveryState()
    finishEncryption?.(envelope)

    await expect(persistence).rejects.toMatchObject({ name: 'AbortError' })
    expect(addPendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('lets an in-flight abandonment reject stale account cleanup', async () => {
    let rejectRemoval: ((error: Error) => void) | undefined
    removePendingRecovery.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectRemoval = reject
      }),
    )
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)

    const abandonment = abandonChatRecoveryAttempt(SESSION_ID)
    await vi.waitFor(() =>
      expect(removePendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        expect.any(Function),
      ),
    )
    const isCurrent = removePendingRecovery.mock.calls[0][2]
    resetChatRecoveryState()
    expect(isCurrent()).toBe(false)
    rejectRemoval?.(new DOMException('Aborted', 'AbortError'))
    await expect(abandonment).rejects.toMatchObject({ name: 'AbortError' })

    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('lets an in-flight cancellation reject stale account cleanup', async () => {
    let rejectRemoval: ((error: Error) => void) | undefined
    removePendingRecovery.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectRemoval = reject
      }),
    )
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)

    const cancellation = cancelChatRecovery('chat-1')
    await vi.waitFor(() =>
      expect(removePendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        expect.any(Function),
      ),
    )
    const isCurrent = removePendingRecovery.mock.calls[0][2]
    resetChatRecoveryState()
    expect(isCurrent()).toBe(false)
    rejectRemoval?.(new DOMException('Aborted', 'AbortError'))
    await expect(cancellation).rejects.toMatchObject({ name: 'AbortError' })

    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('removes a failed envelope before deleting its server session', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('failed')
    let finishRemoval: (() => void) | undefined
    removePendingRecovery.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRemoval = resolve
      }),
    )

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(removePendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    )
    expect(deleteChatRecovery).not.toHaveBeenCalled()

    finishRemoval?.()
    await scan

    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('rewraps an envelope opened with a historical CEK', async () => {
    storedAlternatives = ['historical-key']
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope
      .mockRejectedValueOnce(new Error('wrong key'))
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        recoveryToken: JSON.stringify({
          exportedSecret: '00'.repeat(32),
          requestEnc: '11'.repeat(32),
        }),
      })
    const rewrapped = {
      ...envelope,
      keyId: 'abcdefabcdefabcdefabcdefabcdefab',
    }
    rewrapRecoveryEnvelope.mockResolvedValue(rewrapped)
    replacePendingRecovery.mockResolvedValue({
      pendingRecoveries: [rewrapped],
    })
    getChatRecoveryState.mockResolvedValue('processing')

    await scanPendingChatRecoveries('user-1')

    expect(rewrapRecoveryEnvelope).toHaveBeenCalled()
    expect(replacePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      envelope,
      expect.objectContaining({
        keyId: 'abcdefabcdefabcdefabcdefabcdefab',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })
})
