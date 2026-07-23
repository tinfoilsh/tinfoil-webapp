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
const clearActiveChatRecoveries = vi.fn()
const pruneChatRecoveryDrafts = vi.fn()
const setChatRecoveryActive = vi.fn()
const setChatRecoveryDraft = vi.fn()
const setChatRecoveryPhase = vi.fn()
const retryDeferredAlternativesFinalization = vi.fn()
const parseRichStreamingResponse = vi.fn()
const getAllChats = vi.fn()
const getChat = vi.fn()
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
  clearActiveChatRecoveries: () => clearActiveChatRecoveries(),
  clearChatRecoveryDrafts: () => clearChatRecoveryDrafts(),
  pruneChatRecoveryDrafts: (...args: unknown[]) =>
    pruneChatRecoveryDrafts(...args),
  setChatRecoveryActive: (...args: unknown[]) => setChatRecoveryActive(...args),
  setChatRecoveryDraft: (...args: unknown[]) => setChatRecoveryDraft(...args),
  setChatRecoveryPhase: (...args: unknown[]) => setChatRecoveryPhase(...args),
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
  persistChatRecoveryToken,
  resetChatRecoveryState,
  scanPendingChatRecoveries,
  startChatRecoveryAttempt,
} from '@/services/inference/chat-recovery'

const SESSION_ID = '0123456789abcdef0123456789abcdef'
const REPLACEMENT_SESSION_ID = 'abcdef0123456789abcdef0123456789'
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
    cloudSyncEnabled = true
    getChat.mockResolvedValue({ id: 'chat-1', isLocalOnly: false })
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

  it('stores a local recovery token without a cloud encryption key', async () => {
    cloudSyncEnabled = false
    getChat.mockResolvedValue({ id: 'chat-1', isLocalOnly: true })
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
    expect(addPendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        storage: 'local',
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        recoveryToken: expect.any(String),
      }),
    )
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
    expect(setChatRecoveryPhase.mock.calls).toEqual([
      ['chat-1', 'turn-1', 'replaying'],
      ['chat-1', 'turn-1', 'streaming'],
    ])

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

  it('releases recovery activity before deleting the completed session', async () => {
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
      expect(setChatRecoveryActive).toHaveBeenLastCalledWith(
        'chat-1',
        'turn-1',
        false,
      )
    })

    finishDeletion?.()
    await scan
  })

  it('ignores a replay callback after recovery cancellation', async () => {
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
    let replayComplete: (() => void) | undefined
    let recoverySignal: AbortSignal | undefined
    fetchRecoveredChatResponse.mockImplementation(
      async (
        _sessionId: string,
        _token: unknown,
        signal: AbortSignal,
        _replayBytes: number,
        onReplayComplete: () => void,
      ) => {
        recoverySignal = signal
        replayComplete = onReplayComplete
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

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() => expect(replayComplete).toBeTypeOf('function'))
    await cancelChatRecovery('chat-1')
    setChatRecoveryPhase.mockClear()

    replayComplete?.()

    expect(setChatRecoveryPhase).not.toHaveBeenCalled()
    await scan
  })

  it('publishes the recovered partial when replay catches up', async () => {
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
    let markReplayComplete: (() => void) | undefined
    fetchRecoveredChatResponse.mockImplementation(
      async (
        _sessionId: string,
        _token: unknown,
        _signal: AbortSignal,
        _replayBytes: number,
        onReplayComplete: () => void,
      ) => {
        markReplayComplete = onReplayComplete
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
          content: 'Recovered so far',
          timestamp: new Date().toISOString(),
        })
        expect(setChatRecoveryDraft).not.toHaveBeenCalled()
        markReplayComplete?.()
        expect(setChatRecoveryDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            turnId: 'turn-1',
            message: expect.objectContaining({
              content: 'Recovered so far',
            }),
          }),
        )
        return {
          role: 'assistant',
          content: 'Recovered so far',
          timestamp: new Date().toISOString(),
        }
      },
    )

    await scanPendingChatRecoveries('user-1')

    expect(setChatRecoveryDraft).toHaveBeenCalledTimes(1)
  })

  it('preserves the partial response when recovery returns an upstream error', async () => {
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
    fetchRecoveredChatResponse.mockResolvedValue(
      new Response('{"error":"conflict"}', { status: 409 }),
    )

    await scanPendingChatRecoveries('user-1')

    expect(parseRichStreamingResponse).not.toHaveBeenCalled()
    expect(completePendingRecovery).not.toHaveBeenCalled()
    expect(removePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
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
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
    ])
  })

  it('keeps streaming when a recovered response ends while processing', async () => {
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
      'turn-1',
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
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockImplementation(
      async (
        _sessionId: string,
        _token: unknown,
        _signal: AbortSignal,
        _replayBytes: number,
        _onReplayComplete: () => void,
        onEncryptedBytes: (bytes: number) => void,
      ) => {
        onEncryptedBytes(160)
        return new Response('stream')
      },
    )
    parseRichStreamingResponse
      .mockRejectedValueOnce(new TypeError('terminated'))
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Complete',
        timestamp: new Date().toISOString(),
      })

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(fetchRecoveredChatResponse.mock.calls[1]?.[3]).toBe(160)
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
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

  it('reconnects when completion reports more bytes than the stream read', async () => {
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
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _token: unknown,
          _signal: AbortSignal,
          _replayBytes: number,
          _onReplayComplete: () => void,
          onEncryptedBytes: (bytes: number) => void,
        ) => {
          onEncryptedBytes(0)
          return new Response('partial')
        },
      )
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _token: unknown,
          _signal: AbortSignal,
          _replayBytes: number,
          _onReplayComplete: () => void,
          onEncryptedBytes: (bytes: number) => void,
        ) => {
          onEncryptedBytes(160)
          return new Response('complete')
        },
      )
    parseRichStreamingResponse
      .mockResolvedValueOnce({
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Complete',
        timestamp: new Date().toISOString(),
      })

    await scanPendingChatRecoveries('user-1')

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(2)
    expect(fetchRecoveredChatResponse.mock.calls[1]?.[3]).toBe(128)
    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      expect.objectContaining({ content: 'Complete' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('cleans up a retained session when a replacement completes recovery', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        recoveryToken: JSON.stringify({
          exportedSecret: '00'.repeat(32),
          requestEnc: '11'.repeat(32),
        }),
      })
      .mockResolvedValueOnce({
        sessionId: REPLACEMENT_SESSION_ID,
        recoveryToken: JSON.stringify({
          exportedSecret: '00'.repeat(32),
          requestEnc: '11'.repeat(32),
        }),
      })
    getChatRecoveryState
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('processing')
      .mockResolvedValueOnce('complete')
      .mockResolvedValueOnce('complete')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'Partial',
        timestamp: new Date().toISOString(),
      })
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
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
    ])

    let finishRetainedDeletion: (() => void) | undefined
    deleteChatRecovery.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRetainedDeletion = resolve
        }),
    )
    const replacementScan = scanPendingChatRecoveries('user-1', true)
    await vi.waitFor(() =>
      expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(3),
    )
    finishRetainedDeletion?.()
    await replacementScan

    expect(completePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      expect.objectContaining({ content: 'Complete' }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
    expect(deleteChatRecovery).toHaveBeenCalledWith(REPLACEMENT_SESSION_ID)
  })

  it('releases retained activity when the pending envelope disappears', async () => {
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
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Partial',
      timestamp: new Date().toISOString(),
    })

    await scanPendingChatRecoveries('user-1')
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
    ])

    getAllChats.mockResolvedValue([])
    await scanPendingChatRecoveries('user-1', true)

    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
  })

  it('does not readopt retained recovery after cancellation during status', async () => {
    getAllChats.mockResolvedValue([
      { id: 'chat-1', pendingRecoveries: [envelope] },
    ])
    decryptRecoveryEnvelope
      .mockResolvedValueOnce({
        sessionId: SESSION_ID,
        recoveryToken: JSON.stringify({
          exportedSecret: '00'.repeat(32),
          requestEnc: '11'.repeat(32),
        }),
      })
      .mockResolvedValueOnce({
        sessionId: REPLACEMENT_SESSION_ID,
        recoveryToken: JSON.stringify({
          exportedSecret: '00'.repeat(32),
          requestEnc: '11'.repeat(32),
        }),
      })
    getChatRecoveryState.mockResolvedValue('processing')
    fetchRecoveredChatResponse.mockResolvedValue(new Response('stream'))
    parseRichStreamingResponse.mockResolvedValue({
      role: 'assistant',
      content: 'Partial',
      timestamp: new Date().toISOString(),
    })

    await scanPendingChatRecoveries('user-1')
    const fetchCountBeforeRescan = fetchRecoveredChatResponse.mock.calls.length
    let resolveStatus: ((state: string) => void) | undefined
    getChatRecoveryState.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStatus = resolve
        }),
    )

    const rescan = scanPendingChatRecoveries('user-1', true)
    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'))
    const cancellation = cancelChatRecovery('chat-1')
    resolveStatus?.('processing')
    await Promise.all([rescan, cancellation])

    expect(fetchRecoveredChatResponse).toHaveBeenCalledTimes(
      fetchCountBeforeRescan,
    )
    expect(setChatRecoveryActive.mock.calls).toEqual([
      ['chat-1', 'turn-1', true],
      ['chat-1', 'turn-1', false],
    ])
  })

  it('cancels a recovery stream resumed by a scan', async () => {
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
    let finishRemoval: (() => void) | undefined
    removePendingRecovery.mockImplementationOnce(
      (_chatId: string, _turnId: string, isCurrent: () => boolean) =>
        new Promise<void>((resolve) => {
          finishRemoval = () => {
            expect(isCurrent()).toBe(true)
            resolve()
          }
        }),
    )

    const scan = scanPendingChatRecoveries('user-1')
    await vi.waitFor(() => {
      expect(setChatRecoveryActive).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        true,
      )
    })

    const cancellation = cancelChatRecovery('chat-1')
    await vi.waitFor(() => expect(removePendingRecovery).toHaveBeenCalled())
    await scanPendingChatRecoveries('user-1', true)
    finishRemoval?.()
    await cancellation
    await scan

    expect(recoverySignal?.aborted).toBe(true)
    expect(setChatRecoveryActive).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      false,
    )
    expect(removePendingRecovery).toHaveBeenCalledWith(
      'chat-1',
      'turn-1',
      expect.any(Function),
    )
    expect(deleteChatRecovery).toHaveBeenCalledWith(SESSION_ID)
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

  it('recovers a device-local token directly from IndexedDB', async () => {
    getAllChats.mockResolvedValue([
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
      expect.any(Object),
      expect.any(AbortSignal),
      128,
      expect.any(Function),
      expect.any(Function),
    )
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
