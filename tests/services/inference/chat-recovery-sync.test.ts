import type { Message, PendingRecoveryEnvelope } from '@/components/chat/types'
import type { StoredChat } from '@/services/storage/indexed-db'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let remoteChat: StoredChat
let localChat: StoredChat | undefined
let uploadAttempts = 0
let conflictOnce = false
let applyFailures = 0

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    downloadChat: vi.fn(async () => structuredClone(remoteChat)),
    uploadChat: vi.fn(async (chat: StoredChat) => {
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
    }),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getChat: vi.fn(async () => structuredClone(localChat)),
    applyRemoteChatIfFresh: vi.fn(async ({ chat }: { chat: StoredChat }) => {
      if (applyFailures > 0) {
        applyFailures -= 1
        return { applied: false }
      }
      localChat = structuredClone(chat)
      return { applied: true }
    }),
  },
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
    uploadAttempts = 0
    conflictOnce = false
    applyFailures = 0
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
})
