import type { PendingRecoveryEnvelope } from '@/components/chat/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const clearActiveChatRecoveries = vi.fn()
const getChatRecoveryDraft = vi.fn()
const pruneChatRecoveryDrafts = vi.fn()
const setChatRecoveryActive = vi.fn()
const setChatRecoveryDraft = vi.fn()
const retryDeferredAlternativesFinalization = vi.fn()
const parseRichStreamingResponse = vi.fn()
const generateTitle = vi.fn()
const getPendingChatRecoveries = vi.fn()
const getChat = vi.fn()
const getKeyBytesOrThrow = vi.fn()
let storedAlternatives: string[] = []
let cloudSyncEnabled = true

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
    persistedBytes: 128,
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
  sameRecoveredResponse: (
    existing: { content?: string },
    recovered: { content?: string },
  ) => existing.content === recovered.content,
}))

vi.mock('@/services/inference/chat-recovery-drafts', () => ({
  clearActiveChatRecoveries: () => clearActiveChatRecoveries(),
  clearChatRecoveryDrafts: () => clearChatRecoveryDrafts(),
  getChatRecoveryDraft: (...args: unknown[]) => getChatRecoveryDraft(...args),
  pruneChatRecoveryDrafts: (...args: unknown[]) =>
    pruneChatRecoveryDrafts(...args),
  setChatRecoveryActive: (...args: unknown[]) => setChatRecoveryActive(...args),
  setChatRecoveryDraft: (...args: unknown[]) => setChatRecoveryDraft(...args),
}))

vi.mock('@/services/cloud/legacy-blob-migration', () => ({
  retryDeferredAlternativesFinalization: () =>
    retryDeferredAlternativesFinalization(),
}))

vi.mock('@/components/chat/hooks/streaming', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/chat/hooks/streaming')
  >()),
  parseRichStreamingResponse: (...args: unknown[]) =>
    parseRichStreamingResponse(...args),
}))

vi.mock('@/services/inference/title', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/inference/title')>()),
  generateTitle: (...args: unknown[]) => generateTitle(...args),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKeyBytesOrThrow: () => getKeyBytesOrThrow(),
    getStoredAlternatives: () => storedAlternatives,
    getAlternativeKeyBytes: () => new Uint8Array(32).fill(1),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getPendingChatRecoveries: () => getPendingChatRecoveries(),
    getChat: (...args: unknown[]) => getChat(...args),
  },
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => cloudSyncEnabled,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

import {
  abandonChatRecoveryAttempt,
  cancelChatRecovery,
  markChatRecoveryTurnCancelled,
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

async function persistActiveRecovery(): Promise<void> {
  encryptRecoveryEnvelope.mockResolvedValueOnce(envelope)
  startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
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
}

describe('chat recovery lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetChatRecoveryState()
    envelope.createdAt = new Date().toISOString()
    envelope.expiresAt = new Date(Date.now() + 60_000).toISOString()
    getKeyBytesOrThrow.mockReturnValue(new Uint8Array(32))
    storedAlternatives = []
    cloudSyncEnabled = true
    getChat.mockResolvedValue({ id: 'chat-1', isLocalOnly: false })
    generateTitle.mockResolvedValue('Untitled')
    deleteChatRecovery.mockResolvedValue(undefined)
    removePendingRecovery.mockResolvedValue(undefined)
    addPendingRecovery.mockResolvedValue(undefined)
    completePendingRecovery.mockResolvedValue(undefined)
    replacePendingRecovery.mockResolvedValue(undefined)
    retryDeferredAlternativesFinalization.mockResolvedValue(undefined)
  })

  afterEach(() => {
    resetChatRecoveryState()
    vi.restoreAllMocks()
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
    await expect(cancellation).resolves.toBe(false)

    expect(encryptRecoveryEnvelope).not.toHaveBeenCalled()
    expect(addPendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('discards a token captured after the turn was marked cancelled', async () => {
    // Stop pressed before the first token: cancelGeneration marks the turn
    // cancelled synchronously with the abort, while the in-flight request's
    // token capture races it. The late token must not register an envelope
    // (which would surface "Recovering stream..." for a stopped turn).
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
    markChatRecoveryTurnCancelled('chat-1', 'turn-1')

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

    expect(addPendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('cancels only the stopped turn when a successor is already active', async () => {
    const successorSessionId = 'fedcba9876543210fedcba9876543210'
    const successorEnvelope = { ...envelope, turnId: 'turn-2' }
    encryptRecoveryEnvelope
      .mockResolvedValueOnce(envelope)
      .mockResolvedValueOnce(successorEnvelope)
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
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
    startChatRecoveryAttempt('chat-1', 'turn-2', successorSessionId)
    await persistChatRecoveryToken({
      userId: 'user-1',
      chatId: 'chat-1',
      turnId: 'turn-2',
      sessionId: successorSessionId,
      token: {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32),
      },
    })

    await cancelChatRecovery('chat-1', undefined, 'turn-1')

    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
    expect(deleteChatRecovery).not.toHaveBeenCalledWith(successorSessionId)
    expect(removePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      envelope,
      expect.any(Function),
    )
    expect(removePendingRecovery).not.toHaveBeenCalledWith(
      'chat-1',
      successorEnvelope,
      expect.any(Function),
    )
  })

  it('discards a cancelled-turn token even when the mark lands mid-persist', async () => {
    // Narrower window: the cancel mark arrives after persistChatRecoveryToken
    // already passed its entry checks and is awaiting envelope encryption.
    startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)
    encryptRecoveryEnvelope.mockImplementationOnce(async () => {
      markChatRecoveryTurnCancelled('chat-1', 'turn-1')
      return envelope
    })

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

    expect(addPendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('retains the recovery session when interrupted output cannot be saved', async () => {
    await persistActiveRecovery()
    completePendingRecovery.mockRejectedValueOnce(new Error('save failed'))

    await expect(
      cancelChatRecovery('chat-1', {
        role: 'assistant',
        content: 'Partial answer',
        turnId: 'turn-1',
        timestamp: new Date(),
      }),
    ).rejects.toThrow('save failed')

    expect(deleteChatRecovery).not.toHaveBeenCalled()
  })

  it('does not overwrite a concurrently removed recovery', async () => {
    await persistActiveRecovery()
    completePendingRecovery.mockResolvedValueOnce({
      id: 'chat-1',
      messages: [{ role: 'user', content: 'Question', turnId: 'turn-1' }],
    })

    const handled = await cancelChatRecovery('chat-1', {
      role: 'assistant',
      content: 'Partial answer',
      turnId: 'turn-1',
      timestamp: new Date(),
    })

    expect(handled).toBe(true)
    expect(deleteChatRecovery).not.toHaveBeenCalled()
  })

  it.each([
    { syncEnabled: false, isLocalOnly: false },
    { syncEnabled: true, isLocalOnly: true },
  ])(
    'stores a local recovery token without a cloud key when sync=$syncEnabled local=$isLocalOnly',
    async ({ syncEnabled, isLocalOnly }) => {
      cloudSyncEnabled = syncEnabled
      getChat.mockResolvedValue({ id: 'chat-1', isLocalOnly })
      getKeyBytesOrThrow.mockImplementation(() => {
        throw new Error('No cloud key')
      })
      startChatRecoveryAttempt('chat-1', 'turn-1', SESSION_ID)

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

      expect(encryptRecoveryEnvelope).not.toHaveBeenCalled()
      expect(getKeyBytesOrThrow).not.toHaveBeenCalled()
      expect(addPendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          storage: 'local',
          sessionId: SESSION_ID,
          turnId: 'turn-1',
          recoveryToken: JSON.stringify({
            exportedSecret: '00'.repeat(32),
            requestEnc: '00'.repeat(32),
          }),
        }),
      )
    },
  )

  it('streams a processing session and persists only after completion', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
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
        expect(setChatRecoveryDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            turnId: 'turn-1',
            message: expect.objectContaining({ content: 'Recover' }),
          }),
        )
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
      expect.objectContaining({ turnId: 'turn-1' }),
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

  it('generates a title when the first response is recovered', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    getChat.mockResolvedValue({
      id: 'chat-1',
      title: 'Untitled',
      titleState: 'placeholder',
      messages: [
        {
          role: 'user',
          turnId: 'turn-1',
          content: '',
          attachments: [
            {
              fileName: 'recovery.txt',
              textContent: '   ',
              description: 'How does encrypted recovery work?',
            },
          ],
        },
      ],
    })
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Recovered',
      timestamp: new Date().toISOString(),
    })
    generateTitle.mockResolvedValue('Encrypted recovery')

    await scanPendingChatRecoveries('user-1')

    expect(generateTitle).toHaveBeenCalledWith([
      { role: 'user', content: 'How does encrypted recovery work?' },
    ])
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({ content: 'Recovered' }),
      {
        title: 'Encrypted recovery',
        titleState: 'generated',
        expectedTitleState: 'placeholder',
      },
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('releases recovery activity before deleting the completed session', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Recovered',
      timestamp: new Date().toISOString(),
    })
    let finishDeletion: (() => void) | undefined
    deleteChatRecovery.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDeletion = resolve
        }),
    )

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() => {
      expect(completePendingRecovery).toHaveBeenCalled()
      expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
      expect(finishDeletion).toBeTypeOf('function')
      expect(setChatRecoveryActive).toHaveBeenLastCalledWith(
        'chat-1',
        'turn-1',
        false,
      )
    })

    finishDeletion?.()
    await scan
  })

  it('ignores a stream update after recovery cancellation', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    let recoverySignal: AbortSignal | undefined
    let publishUpdate: ((message: object) => void) | undefined
    fetchRecoveredChatResponse.mockImplementation(
      async (_sessionId: string, _token: unknown, signal: AbortSignal) => {
        recoverySignal = signal
        return new Response('stream')
      },
    )
    parseRichStreamingResponse.mockImplementation(
      (_response: Response, options: { onUpdate: (message: object) => void }) =>
        new Promise((_resolve, reject) => {
          publishUpdate = options.onUpdate
          const rejectAbort = () =>
            reject(new DOMException('Aborted', 'AbortError'))
          if (recoverySignal?.aborted) {
            rejectAbort()
          } else {
            recoverySignal?.addEventListener('abort', rejectAbort, {
              once: true,
            })
          }
        }),
    )

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() => expect(publishUpdate).toBeTypeOf('function'))
    await cancelChatRecovery('chat-1')

    publishUpdate?.({
      role: 'assistant',
      content: 'Stale replay',
      timestamp: new Date().toISOString(),
    })

    expect(setChatRecoveryDraft).not.toHaveBeenCalled()
    await scan
  })

  it('releases recovery activity when checkpoint loading fails', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    getChat.mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('processing')

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).not.toHaveBeenCalled()
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
  })

  it('preserves the partial response when recovery returns an upstream error', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    fetchRecoveredChatResponse.mockResolvedValue(
      new Response('{"error":"conflict"}', { status: 409 }),
    )

    await scanPendingChatRecoveries('user-1')

    expect(parseRichStreamingResponse).not.toHaveBeenCalled()
    expect(completePendingRecovery).not.toHaveBeenCalled()
    expect(removePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('keeps recovery active through repeated processing reconnects', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
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
    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(4)
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({ content: 'Partial' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
  })

  it('keeps streaming when a recovered response ends while processing', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse
      .mockResolvedValueOnce(new Response('partial'))
      .mockResolvedValueOnce(new Response('complete'))
    parseRichStreamingResponse
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Partial',
        timestamp: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Complete',
        timestamp: new Date().toISOString(),
      })

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({ content: 'Complete' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
  })

  it('reconnects when a recovered response transport terminates', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse
      .mockRejectedValueOnce(new TypeError('terminated'))
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Complete',
        timestamp: new Date().toISOString(),
      })

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(fetchRecoveredChatResponse.mock.calls[1]).toEqual([
      SESSION_ID,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    ])
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({ content: 'Complete' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
  })

  it('replays from zero when a completed response is truncated', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _token: unknown,
          _signal: AbortSignal,
          onEncryptedBytes: (bytes: number) => void,
        ) => {
          onEncryptedBytes(64)
          return new Response('partial')
        },
      )
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _token: unknown,
          _signal: AbortSignal,
          onEncryptedBytes: (bytes: number) => void,
        ) => {
          onEncryptedBytes(128)
          return new Response('complete')
        },
      )
    parseRichStreamingResponse
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Partial',
        timestamp: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Complete',
        timestamp: new Date().toISOString(),
      })

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(fetchRecoveredChatResponse.mock.calls[1]).toEqual([
      SESSION_ID,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    ])
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({ content: 'Complete' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('does not regress the visible draft while replaying after reconnect', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryDraft.mockReturnValue({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: SESSION_ID,
      message: {
        role: 'assistant',
        content: 'Already shown',
        timestamp: new Date().toISOString(),
      },
    })
    getChatRecoveryState
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse
      .mockImplementationOnce(
        async (
          _response: Response,
          options: { onUpdate: (message: object) => void },
        ) => {
          options.onUpdate({
            role: 'assistant',
            content: 'Old prefix',
            timestamp: new Date().toISOString(),
          })
          throw new TypeError('terminated')
        },
      )
      .mockImplementationOnce(
        async (
          _response: Response,
          options: { onUpdate: (message: object) => void },
        ) => {
          options.onUpdate({
            role: 'assistant',
            content: 'Old prefix',
            timestamp: new Date().toISOString(),
          })
          options.onUpdate({
            role: 'assistant',
            content: 'Already shown',
            timestamp: new Date().toISOString(),
          })
          options.onUpdate({
            role: 'assistant',
            content: 'Newest',
            timestamp: new Date().toISOString(),
          })
          return {
            role: 'assistant',
            content: 'Newest',
            timestamp: new Date().toISOString(),
          }
        },
      )

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(setChatRecoveryDraft).toHaveBeenCalledTimes(1)
    expect(setChatRecoveryDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ content: 'Newest' }),
      }),
    )
  })

  it('ignores a presentation checkpoint from a replaced session', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryDraft.mockReturnValue({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: 'fedcba9876543210fedcba9876543210',
      message: {
        role: 'assistant',
        content: 'Output from replaced session',
        timestamp: new Date().toISOString(),
      },
    })
    getChatRecoveryState
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockImplementation(
      async (
        _response: Response,
        options: { onUpdate: (message: object) => void },
      ) => {
        const message = {
          role: 'assistant',
          content: 'New session output',
          timestamp: new Date().toISOString(),
        }
        options.onUpdate(message)
        return message
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(setChatRecoveryDraft).toHaveBeenCalledTimes(1)
    expect(setChatRecoveryDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        message: expect.objectContaining({ content: 'New session output' }),
      }),
    )
  })

  it('keeps a persisted partial visible until replay catches up', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    getChat.mockResolvedValue({
      id: 'chat-1',
      isLocalOnly: false,
      messages: [
        {
          role: 'assistant',
          turnId: 'turn-1',
          content: 'Already persisted',
          timestamp: new Date().toISOString(),
        },
      ],
    })
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockImplementation(
      async (
        _response: Response,
        options: { onUpdate: (message: object) => void },
      ) => {
        options.onUpdate({
          role: 'assistant',
          content: 'Old prefix',
          timestamp: new Date().toISOString(),
        })
        options.onUpdate({
          role: 'assistant',
          content: 'Already persisted',
          timestamp: new Date().toISOString(),
        })
        options.onUpdate({
          role: 'assistant',
          content: 'New streamed content',
          timestamp: new Date().toISOString(),
        })
        return {
          role: 'assistant',
          content: 'New streamed content',
          timestamp: new Date().toISOString(),
        }
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(setChatRecoveryDraft).toHaveBeenCalledTimes(1)
    expect(setChatRecoveryDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ content: 'New streamed content' }),
      }),
    )
  })

  it('reuses an in-flight recovery scan instead of restarting its stream', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    let recoverySignal: AbortSignal | undefined
    fetchRecoveredChatResponse.mockImplementation(
      async (_sessionId: string, _token: unknown, signal: AbortSignal) => {
        recoverySignal = signal
        return new Response('stream')
      },
    )
    parseRichStreamingResponse.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          recoverySignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )

    const firstScan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1),
    )
    const repeatedScan = scanPendingChatRecoveries('user-1')

    expect(repeatedScan).toBe(firstScan)
    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1)

    await cancelChatRecovery('chat-1')
    await firstScan
  })

  it('queues refreshed discovery without restarting the active stream', async () => {
    getPendingChatRecoveries
      .mockResolvedValueOnce([{ id: 'chat-1', pendingRecoveries: [envelope] }])
      .mockResolvedValueOnce([])
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    let finishStream: ((message: object) => void) | undefined
    parseRichStreamingResponse.mockReturnValueOnce(
      new Promise((resolve) => {
        finishStream = resolve
      }),
    )

    const activeScan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1),
    )
    const refresh = scanPendingChatRecoveries('user-1', true)

    expect(refresh).toBe(activeScan)
    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1)

    finishStream?.({
      role: 'assistant',
      content: 'Complete',
      timestamp: new Date().toISOString(),
    })
    await activeScan
    await vi.waitFor(() =>
      expect(getPendingChatRecoveries).toHaveBeenCalledTimes(2),
    )
  })

  it('saves the visible draft when cancelling a resumed recovery stream', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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
    let recoverySignal: AbortSignal | undefined
    fetchRecoveredChatResponse.mockImplementation(
      async (_sessionId: string, _token: unknown, signal: AbortSignal) => {
        recoverySignal = signal
        return new Response('stream')
      },
    )
    parseRichStreamingResponse.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const rejectAbort = () =>
            reject(new DOMException('Aborted', 'AbortError'))
          if (recoverySignal?.aborted) {
            rejectAbort()
          } else {
            recoverySignal?.addEventListener('abort', rejectAbort, {
              once: true,
            })
          }
        }),
    )
    getChatRecoveryDraft.mockReturnValue({
      chatId: 'chat-1',
      turnId: 'turn-1',
      sessionId: SESSION_ID,
      message: {
        role: 'assistant',
        content: '',
        thoughts: 'Recovered reasoning so far',
        isThinking: true,
        timestamp: new Date(),
        timeline: [
          {
            type: 'thinking',
            id: 'thinking-0',
            content: 'Recovered reasoning so far',
            isThinking: true,
          },
        ],
      },
    })
    completePendingRecovery.mockResolvedValueOnce({
      id: 'chat-1',
      messages: [
        {
          role: 'assistant',
          content: '',
          thoughts: 'Recovered reasoning so far',
          isThinking: false,
          turnId: 'turn-1',
        },
      ],
    })

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() => {
      expect(setChatRecoveryActive).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        true,
      )
    })

    const result = await cancelChatRecovery('chat-1')
    await scan

    expect(result).toBe(true)
    expect(recoverySignal?.aborted).toBe(true)
    expect(setChatRecoveryActive).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      false,
    )
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ turnId: 'turn-1' }),
      expect.objectContaining({
        turnId: 'turn-1',
        thoughts: 'Recovered reasoning so far',
        isThinking: false,
        timeline: [
          expect.objectContaining({
            type: 'thinking',
            content: 'Recovered reasoning so far',
            isThinking: false,
          }),
        ],
      }),
      {},
      expect.any(Function),
    )
    expect(removePendingRecovery).not.toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('replays a completed response through progressive drafts', async () => {
    getPendingChatRecoveries.mockResolvedValue([
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

    expect(setChatRecoveryDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        turnId: 'turn-1',
        message: expect.objectContaining({ content: 'Replay prefix' }),
      }),
    )
    expect(completePendingRecovery).toHaveBeenCalled()
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('recovers a device-local token directly from IndexedDB', async () => {
    getPendingChatRecoveries.mockResolvedValue([
      {
        id: 'chat-1',
        isLocalOnly: true,
        pendingRecoveries: [
          {
            v: 1,
            storage: 'local',
            turnId: 'turn-1',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            sessionId: SESSION_ID,
            recoveryToken: JSON.stringify({
              exportedSecret: '00'.repeat(32),
              requestEnc: '11'.repeat(32),
            }),
          },
        ],
      },
    ])
    getChatRecoveryState.mockResolvedValue('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Recovered locally',
      timestamp: new Date().toISOString(),
    })

    await scanPendingChatRecoveries('user-1')

    expect(decryptRecoveryEnvelope).not.toHaveBeenCalled()
    expect(fetchRecoveredChatResponse).toHaveBeenCalledWith(
      SESSION_ID,
      {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32).fill(0x11),
      },
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        storage: 'local',
        turnId: 'turn-1',
        sessionId: SESSION_ID,
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Recovered locally',
        turnId: 'turn-1',
      }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('stops an old account scan when recovery state is reset', async () => {
    let resolveChats: ((chats: unknown[]) => void) | undefined
    getPendingChatRecoveries.mockReturnValueOnce(
      new Promise<unknown[]>((resolve) => {
        resolveChats = resolve
      }),
    )
    const oldScan = scanPendingChatRecoveries('old-user')

    resetChatRecoveryState()
    resolveChats?.([{ id: 'chat-1', pendingRecoveries: [envelope] }])
    await oldScan

    expect(decryptRecoveryEnvelope).not.toHaveBeenCalled()
    getPendingChatRecoveries.mockResolvedValueOnce([])
    await expect(scanPendingChatRecoveries('new-user')).resolves.toBeUndefined()
  })

  it('aborts an aged scan before starting its replacement', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    getPendingChatRecoveries.mockResolvedValue([
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
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
    dateNow.mockRestore()
  })

  it('replaces reconnects that report no forward progress', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    getPendingChatRecoveries.mockResolvedValue([
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    })

    const oldScan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1),
    )
    now = 50_000
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2),
    )

    now = 1_000 + RECOVERY_SCAN_MAX_AGE_MS
    const replacement = scanPendingChatRecoveries('user-1')

    expect(replacement).not.toBe(oldScan)
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(3),
    )
    expect(
      (fetchRecoveredChatResponse.mock.calls[0][2] as AbortSignal).aborted,
    ).toBe(true)
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', true],
    ])

    await cancelChatRecovery('chat-1')
    await replacement
    await oldScan
    dateNow.mockRestore()
  })

  it('retains stale recovery ownership when replacement discovery fails', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    getPendingChatRecoveries
      .mockResolvedValueOnce([{ id: 'chat-1', pendingRecoveries: [envelope] }])
      .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
      .mockResolvedValueOnce([])
    decryptRecoveryEnvelope.mockResolvedValue({
      sessionId: SESSION_ID,
      recoveryToken: JSON.stringify({
        exportedSecret: '00'.repeat(32),
        requestEnc: '11'.repeat(32),
      }),
    })
    getChatRecoveryState.mockResolvedValue('processing')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    let recoverySignal: AbortSignal | undefined
    parseRichStreamingResponse.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          recoverySignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    fetchRecoveredChatResponse.mockImplementation(
      async (_sessionId: string, _token: unknown, signal: AbortSignal) => {
        recoverySignal = signal
        return new Response('stream')
      },
    )

    const oldScan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(1),
    )
    now += RECOVERY_SCAN_MAX_AGE_MS

    await expect(scanPendingChatRecoveries('user-1')).rejects.toThrow(
      'IndexedDB unavailable',
    )
    await oldScan
    expect(setChatRecoveryActive).not.toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      false,
    )

    await scanPendingChatRecoveries('user-1')
    expect(setChatRecoveryActive).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      false,
    )
    fetchRecoveredChatResponse.mockReset()
    parseRichStreamingResponse.mockReset()
    dateNow.mockRestore()
  })

  it('does not invalidate a live attempt when a recovery scan starts', async () => {
    getPendingChatRecoveries.mockResolvedValue([])
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

    await vi.waitFor(() =>
      expect(encryptRecoveryEnvelope).toHaveBeenCalledOnce(),
    )
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
    await persistActiveRecovery()

    const abandonment = abandonChatRecoveryAttempt(SESSION_ID)
    await vi.waitFor(() =>
      expect(removePendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ turnId: 'turn-1' }),
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
    await persistActiveRecovery()

    const cancellation = cancelChatRecovery('chat-1')
    await vi.waitFor(() =>
      expect(removePendingRecovery).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ turnId: 'turn-1' }),
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
    getPendingChatRecoveries.mockResolvedValue([
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
        expect.objectContaining({ turnId: 'turn-1' }),
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
    getPendingChatRecoveries.mockResolvedValue([
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
    getChatRecoveryState
      .mockResolvedValueOnce('complete')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValueOnce(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValueOnce({
      role: 'assistant',
      content: 'Recovered with historical key',
      timestamp: new Date(),
    })

    await scanPendingChatRecoveries('user-1')

    expect(rewrapRecoveryEnvelope).toHaveBeenCalledExactlyOnceWith({
      envelope,
      userId: 'user-1',
      chatId: 'chat-1',
      oldCek: new Uint8Array(32).fill(1),
      newCek: new Uint8Array(32),
    })
    expect(replacePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      envelope,
      expect.objectContaining({
        keyId: 'abcdefabcdefabcdefabcdefabcdefab',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(fetchRecoveredChatResponse).toHaveBeenCalledWith(
      SESSION_ID,
      {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32).fill(0x11),
      },
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      rewrapped,
      expect.objectContaining({
        content: 'Recovered with historical key',
        turnId: 'turn-1',
      }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })
})
