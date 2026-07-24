import type { Message, PendingRecoveryEnvelope } from '@/components/chat/types'
import type { StoredChat } from '@/services/storage/indexed-db'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let remoteChat: StoredChat
let localChat: StoredChat | undefined
let uploadAttempts = 0
let conflictOnce = false
let applyFailures = 0
let cloudSyncEnabled = true
const downloadChat = vi.fn(async () => structuredClone(remoteChat))
const uploadChat = vi.fn(async (chat: StoredChat) => {
  uploadAttempts += 1
  if (conflictOnce) {
    conflictOnce = false
    throw new SyncEnclaveError('conflict', 409, 'SYNC_CONFLICT')
  }
  remoteChat = {
    ...structuredClone(chat),
    syncVersion: uploadAttempts + 1,
  }
  return remoteChat
})
const getChat = vi.fn(async () => structuredClone(localChat))
const applyRemoteChatIfFresh = vi.fn(async ({ chat }: { chat: StoredChat }) => {
  if (applyFailures > 0) {
    applyFailures -= 1
    return { applied: false }
  }
  localChat = structuredClone(chat)
  return { applied: true }
})
const mutateChat = vi.fn(
  async (
    _chatId: string,
    mutation: (chat: StoredChat) => {
      chat: StoredChat
      changed: boolean
    },
  ) => {
    if (!localChat) return null
    const result = mutation(structuredClone(localChat))
    if (result.changed) {
      localChat = structuredClone(result.chat)
    }
    return structuredClone(result.chat)
  },
)

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    downloadChat: (chatId: string) => downloadChat(chatId),
    uploadChat: (chat: StoredChat) => uploadChat(chat),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getChat: (chatId: string) => getChat(chatId),
    mutateChat: (
      chatId: string,
      mutation: (chat: StoredChat) => {
        chat: StoredChat
        changed: boolean
      },
    ) => mutateChat(chatId, mutation),
    applyRemoteChatIfFresh: (args: { chat: StoredChat }) =>
      applyRemoteChatIfFresh(args),
  },
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => cloudSyncEnabled,
}))

vi.mock('@/services/cloud/edit-clock', () => ({
  nextClock: vi.fn(() => ({ v: 42, w: 'writer' })),
}))

vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: { emit: vi.fn() },
}))

vi.mock('@/services/sync-enclave/sync-api', () => ({
  newIdempotencyKey: vi.fn(() => 'idempotency-key'),
}))

import {
  addPendingRecovery,
  completePendingRecovery,
  replacePendingRecovery,
  resetChatRecoverySyncState,
} from '@/services/inference/chat-recovery-sync'

function message(
  role: Message['role'],
  content: string,
  turnId?: string,
): Message {
  return { role, content, turnId, timestamp: new Date().toISOString() }
}

function envelope(turnId: string): PendingRecoveryEnvelope {
  return {
    v: 1,
    sessionId: '0123456789abcdef0123456789abcdef',
    turnId,
    keyId: 'key-id',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA',
  }
}

describe('chat recovery sync mutations', () => {
  beforeEach(() => {
    resetChatRecoverySyncState()
    uploadAttempts = 0
    conflictOnce = false
    applyFailures = 0
    cloudSyncEnabled = true
    downloadChat.mockClear()
    uploadChat.mockClear()
    getChat.mockClear()
    applyRemoteChatIfFresh.mockClear()
    mutateChat.mockClear()
    remoteChat = {
      id: 'chat-id',
      title: 'Chat',
      model: 'model',
      messages: [message('user', 'Question', 'turn-1')],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncVersion: 1,
    }
    localChat = structuredClone(remoteChat)
  })

  it('retries a conflict and synchronizes the encrypted envelope', async () => {
    conflictOnce = true

    const result = await addPendingRecovery(remoteChat.id, envelope('turn-1'))

    expect(uploadAttempts).toBe(2)
    expect(result.pendingRecoveries).toHaveLength(1)
    expect(localChat?.pendingRecoveries).toEqual(result.pendingRecoveries)
  })

  it('keeps recovery state local when cloud sync is disabled', async () => {
    cloudSyncEnabled = false

    await addPendingRecovery(remoteChat.id, envelope('turn-1'))
    await completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )

    expect(downloadChat).not.toHaveBeenCalled()
    expect(uploadChat).not.toHaveBeenCalled()
    expect(mutateChat).toHaveBeenCalledTimes(2)
    expect(localChat?.messages.map((item) => item.content)).toEqual([
      'Question',
      'Recovered answer',
    ])
    expect(localChat?.pendingRecoveries).toBeUndefined()
  })

  it('finishes a local recovery after cloud sync is enabled', async () => {
    localChat = {
      ...localChat!,
      isLocalOnly: false,
      pendingRecoveries: [
        {
          v: 1,
          storage: 'local',
          turnId: 'turn-1',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sessionId: '0123456789abcdef0123456789abcdef',
          recoveryToken: 'local-token',
        },
      ],
    }

    await completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )

    expect(downloadChat).not.toHaveBeenCalled()
    expect(uploadChat).not.toHaveBeenCalled()
    expect(localChat?.messages[1].content).toBe('Recovered answer')
    expect(localChat?.pendingRecoveries).toBeUndefined()
  })

  it('preserves a newer unsynced local edit while adding recovery state', async () => {
    remoteChat.updatedAt = '2026-01-01T00:00:00.000Z'
    localChat = {
      ...structuredClone(remoteChat),
      title: 'Locally renamed',
      updatedAt: '2026-01-01T00:01:00.000Z',
      locallyModified: true,
    }

    await addPendingRecovery(remoteChat.id, envelope('turn-1'))

    expect(remoteChat.title).toBe('Locally renamed')
    expect(remoteChat.pendingRecoveries).toHaveLength(1)
  })

  it('merges a recovered response once after its user turn', async () => {
    remoteChat.messages.push(message('user', 'Later question', 'turn-2'))
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)
    const assistant = message('assistant', 'Recovered answer', 'turn-1')

    await completePendingRecovery(remoteChat.id, 'turn-1', assistant)
    await completePendingRecovery(remoteChat.id, 'turn-1', assistant)

    expect(remoteChat.messages.map((item) => item.content)).toEqual([
      'Question',
      'Recovered answer',
      'Later question',
    ])
    expect(remoteChat.pendingRecoveries).toBeUndefined()
  })

  it('retries when a concurrent local edit rejects the first local apply', async () => {
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)
    applyFailures = 1

    await completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )

    expect(localChat?.messages.map((item) => item.content)).toEqual([
      'Question',
      'Recovered answer',
    ])
    expect(localChat?.pendingRecoveries).toBeUndefined()
  })

  it('replaces an interrupted partial message with the recovered response', async () => {
    remoteChat.messages.push({
      ...message('assistant', '', 'turn-1'),
      thoughts: 'Drafting an outline',
      isThinking: true,
    })
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)

    await completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )

    expect(remoteChat.messages).toHaveLength(2)
    expect(remoteChat.messages[1].content).toBe('Recovered answer')
    expect(remoteChat.messages[1].isThinking).toBeUndefined()
    expect(remoteChat.pendingRecoveries).toBeUndefined()
  })

  it('updates recovered search reasoning when response content is unchanged', async () => {
    remoteChat.messages.push({
      ...message('assistant', 'Recovered answer', 'turn-1'),
      searchReasoning: 'Partial search context',
    })
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)

    await completePendingRecovery(remoteChat.id, 'turn-1', {
      ...message('assistant', 'Recovered answer', 'turn-1'),
      searchReasoning: 'Complete search context',
    })

    expect(remoteChat.messages[1].searchReasoning).toBe(
      'Complete search context',
    )
    expect(remoteChat.pendingRecoveries).toBeUndefined()
  })

  it('appends the recovered response when the user turn has not synced', async () => {
    remoteChat.messages = [message('user', 'Question', 'other-turn')]
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)

    await completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )

    expect(remoteChat.messages.map((item) => item.content)).toEqual([
      'Question',
      'Recovered answer',
    ])
    expect(remoteChat.pendingRecoveries).toBeUndefined()
  })

  it('does not restore a response after another device cancels the turn', async () => {
    const assistant = message('assistant', 'Late recovered answer', 'turn-1')

    await completePendingRecovery(remoteChat.id, 'turn-1', assistant)

    expect(remoteChat.messages).toHaveLength(1)
    expect(uploadAttempts).toBe(0)
  })

  it('persists a live metadata patch after concurrent completion', async () => {
    const assistant = message('assistant', 'Recovered answer', 'turn-1')
    remoteChat.messages.push(assistant)
    localChat = structuredClone(remoteChat)

    await completePendingRecovery(remoteChat.id, 'turn-1', assistant, {
      title: 'Generated title',
      model: 'new-model',
    })

    expect(remoteChat.title).toBe('Generated title')
    expect(remoteChat.model).toBe('new-model')
    expect(uploadAttempts).toBe(1)
  })

  it('does not reintroduce an envelope removed by another device', async () => {
    await replacePendingRecovery(remoteChat.id, envelope('turn-1'), {
      ...envelope('turn-1'),
      keyId: 'abcdefabcdefabcdefabcdefabcdefab',
    })

    expect(remoteChat.pendingRecoveries).toBeUndefined()
    expect(uploadAttempts).toBe(0)
  })

  it('releases queued mutations when a stalled mutation is aborted', async () => {
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)
    const controller = new AbortController()
    let finishStalledUpload: ((chat: StoredChat) => void) | undefined
    let markStalledUploadSettled: (() => void) | undefined
    const stalledUploadSettled = new Promise<void>((resolve) => {
      markStalledUploadSettled = resolve
    })
    uploadChat.mockImplementationOnce((chat: StoredChat) =>
      new Promise<StoredChat>((resolve) => {
        finishStalledUpload = resolve
      }).then((uploaded) => {
        uploadAttempts += 1
        markStalledUploadSettled?.()
        return uploaded
      }),
    )

    const stalled = completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Stale answer', 'turn-1'),
      undefined,
      undefined,
      controller.signal,
    )
    await vi.waitFor(() => expect(uploadChat).toHaveBeenCalledTimes(1))

    const replacement = completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )
    expect(uploadChat).toHaveBeenCalledTimes(1)

    controller.abort()
    await expect(stalled).rejects.toMatchObject({ name: 'AbortError' })
    await replacement

    expect(uploadChat).toHaveBeenCalledTimes(2)
    expect(applyRemoteChatIfFresh).toHaveBeenCalledTimes(1)
    expect(localChat?.messages[1].content).toBe('Recovered answer')

    const staleUploadResult = {
      ...structuredClone(remoteChat),
      messages: [
        remoteChat.messages[0],
        message('assistant', 'Stale answer', 'turn-1'),
      ],
      syncVersion: 2,
    }
    finishStalledUpload?.(staleUploadResult)
    await stalledUploadSettled
    await Promise.resolve()

    expect(applyRemoteChatIfFresh).toHaveBeenCalledTimes(1)
    expect(localChat?.messages[1].content).toBe('Recovered answer')
  })

  it('does not execute an aborted mutation that is waiting in the queue', async () => {
    remoteChat.pendingRecoveries = [envelope('turn-1')]
    localChat = structuredClone(remoteChat)
    let finishFirstUpload: (() => void) | undefined
    uploadChat.mockImplementationOnce((chat: StoredChat) => {
      const uploadedChat = structuredClone(chat)
      return new Promise<StoredChat>((resolve) => {
        finishFirstUpload = () => {
          uploadAttempts += 1
          remoteChat = {
            ...uploadedChat,
            syncVersion: 2,
          }
          resolve(remoteChat)
        }
      })
    })

    const first = completePendingRecovery(
      remoteChat.id,
      'turn-1',
      message('assistant', 'Recovered answer', 'turn-1'),
    )
    await vi.waitFor(() => expect(uploadChat).toHaveBeenCalledTimes(1))

    const controller = new AbortController()
    const aborted = replacePendingRecovery(
      remoteChat.id,
      envelope('turn-1'),
      { ...envelope('turn-1'), keyId: 'replacement-key' },
      undefined,
      controller.signal,
    )
    const following = addPendingRecovery(remoteChat.id, envelope('turn-2'))

    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(downloadChat).toHaveBeenCalledTimes(1)

    finishFirstUpload?.()
    await first
    const result = await following

    expect(uploadChat).toHaveBeenCalledTimes(2)
    expect(downloadChat).toHaveBeenCalledTimes(2)
    expect(result.pendingRecoveries?.map((pending) => pending.turnId)).toEqual([
      'turn-2',
    ])
  })
})
