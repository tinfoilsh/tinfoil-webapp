import type { Chat } from '@/components/chat/types'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  ChatImagesUnavailableError,
  chatStorage,
} from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { setCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  saveChatSpy,
  getChatSpy,
  getAllChatsSpy,
  getAllChatIdsSpy,
  deleteAllChatsSpy,
  backupChatSpy,
  backupChatNowSpy,
  backupChatAndWaitSpy,
  updateCloudChatProjectSpy,
  deleteChatsByProjectSpy,
  acknowledgePendingDeletesSpy,
  deleteRemoteProjectChatsSpy,
  listChatIdsByProjectSpy,
  createAccountOperationGuardSpy,
  withProjectUploadBarrierSpy,
  newIdempotencyKeySpy,
  resetChatTimestampsSpy,
  updateChatLocalOnlySpy,
  updateChatProjectSpy,
  enqueuePendingDeleteSpy,
  deleteChatWithPendingIntentSpy,
  deleteLocalChatSpy,
  deleteFromCloudSpy,
  deleteAllCloudChatsSpy,
  isCloudAuthenticatedSpy,
  chatEventsEmitSpy,
  hasPendingUploadSpy,
  isDeletedSpy,
  markAsDeletedSpy,
  mutateChatSpy,
  loadChatImagesSpy,
  forkCloudChatSpy,
} = vi.hoisted(() => ({
  saveChatSpy: vi.fn(async (chat: unknown) => ({
    saved: true,
    isLocalOnly: (chat as { isLocalOnly?: boolean }).isLocalOnly === true,
  })),
  getChatSpy: vi.fn(async () => null as unknown),
  getAllChatsSpy: vi.fn(async () => [] as unknown[]),
  getAllChatIdsSpy: vi.fn(async () => [] as string[]),
  deleteAllChatsSpy: vi.fn(async () => 0),
  backupChatSpy: vi.fn(async () => {}),
  backupChatNowSpy: vi.fn(async () => {}),
  backupChatAndWaitSpy: vi.fn(async () => {}),
  updateCloudChatProjectSpy: vi.fn(async () => {}),
  deleteChatsByProjectSpy: vi.fn(async () => [] as string[]),
  acknowledgePendingDeletesSpy: vi.fn(async () => {}),
  deleteRemoteProjectChatsSpy: vi.fn(async () => ({ deleted: 0 })),
  listChatIdsByProjectSpy: vi.fn(async () => [] as string[]),
  createAccountOperationGuardSpy: vi.fn(),
  withProjectUploadBarrierSpy: vi.fn(
    async (_projectId: string, operation: () => Promise<unknown>) =>
      operation(),
  ),
  newIdempotencyKeySpy: vi.fn(() => 'delete-key'),
  resetChatTimestampsSpy: vi.fn(async () => {}),
  updateChatLocalOnlySpy: vi.fn(async () => {}),
  updateChatProjectSpy: vi.fn(async () => {}),
  enqueuePendingDeleteSpy: vi.fn(async () => {}),
  deleteChatWithPendingIntentSpy: vi.fn(async () => true),
  deleteLocalChatSpy: vi.fn(async () => {}),
  deleteFromCloudSpy: vi.fn(async () => {}),
  deleteAllCloudChatsSpy: vi.fn(async () => ({ deleted: 0 })),
  isCloudAuthenticatedSpy: vi.fn(async () => false),
  chatEventsEmitSpy: vi.fn(),
  hasPendingUploadSpy: vi.fn(() => false),
  isDeletedSpy: vi.fn((_id: unknown) => false),
  markAsDeletedSpy: vi.fn(),
  mutateChatSpy: vi.fn(
    async (
      _chatId: string,
      _mutation: (chat: unknown) => { chat: unknown; changed: boolean },
    ) => null as unknown,
  ),
  loadChatImagesSpy: vi.fn(async () => ({}) as Record<string, string>),
  forkCloudChatSpy: vi.fn(async () => {}),
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    initialize: vi.fn(async () => {}),
    getChat: getChatSpy,
    saveChat: saveChatSpy,
    getAllChats: getAllChatsSpy,
    getAllChatIds: getAllChatIdsSpy,
    deleteAllChats: deleteAllChatsSpy,
    resetChatTimestamps: resetChatTimestampsSpy,
    updateChatLocalOnly: updateChatLocalOnlySpy,
    updateChatProject: updateChatProjectSpy,
    enqueuePendingDelete: enqueuePendingDeleteSpy,
    deleteChatWithPendingIntent: deleteChatWithPendingIntentSpy,
    deleteChat: deleteLocalChatSpy,
    deleteChatsByProject: deleteChatsByProjectSpy,
    acknowledgePendingDeletes: acknowledgePendingDeletesSpy,
    mutateChat: mutateChatSpy,
  },
}))
vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: {
    backupChat: backupChatSpy,
    backupChatNow: backupChatNowSpy,
    backupChatAndWait: backupChatAndWaitSpy,
    updateChatProject: updateCloudChatProjectSpy,
    deleteFromCloud: deleteFromCloudSpy,
    hasPendingUpload: hasPendingUploadSpy,
    createAccountOperationGuard: createAccountOperationGuardSpy,
    withProjectUploadBarrier: withProjectUploadBarrierSpy,
    forkChat: forkCloudChatSpy,
  },
}))
vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    deleteChatsByProject: deleteRemoteProjectChatsSpy,
    listChatIdsByProject: listChatIdsByProjectSpy,
    deleteAllChats: deleteAllCloudChatsSpy,
    isAuthenticated: isCloudAuthenticatedSpy,
    loadChatImages: loadChatImagesSpy,
  },
}))
vi.mock('@/services/sync-enclave/sync-api', () => ({
  newIdempotencyKey: newIdempotencyKeySpy,
}))
vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: { isStreaming: vi.fn(() => false) },
}))
vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: { emit: chatEventsEmitSpy },
}))
vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: {
    markAsDeleted: markAsDeletedSpy,
    isDeleted: isDeletedSpy,
  },
}))

function setupAccountGuard(userId = 'user-1') {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, userId)
  createAccountOperationGuardSpy.mockImplementation(() => {
    const guardedUserId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
    const isCurrent = () =>
      localStorage.getItem(AUTH_ACTIVE_USER_ID) === guardedUserId
    return {
      userId: guardedUserId,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new Error('Cloud account changed')
      },
    }
  })
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'rev_123_abc',
    title: 'Initial Message Test',
    messages: [],
    createdAt: new Date('2026-06-02T09:00:00Z'),
    isBlankChat: false,
    isLocalOnly: false,
    pendingSave: true,
    ...overrides,
  }
}

describe('chatStorage pendingSave is not persisted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    isDeletedSpy.mockReturnValue(false)
    setupAccountGuard()
    deleteChatsByProjectSpy.mockResolvedValue([])
    deleteRemoteProjectChatsSpy.mockResolvedValue({ deleted: 0 })
    acknowledgePendingDeletesSpy.mockResolvedValue(undefined)
    listChatIdsByProjectSpy.mockResolvedValue([])
    deleteChatWithPendingIntentSpy.mockResolvedValue(true)
    hasPendingUploadSpy.mockReturnValue(false)
    getAllChatIdsSpy.mockResolvedValue([])
    deleteAllChatsSpy.mockResolvedValue(0)
    deleteAllCloudChatsSpy.mockResolvedValue({ deleted: 0 })
    isCloudAuthenticatedSpy.mockResolvedValue(false)
  })

  it('strips pendingSave before writing a chat to storage', async () => {
    await chatStorage.saveChat(makeChat(), true)

    expect(saveChatSpy).toHaveBeenCalledTimes(1)
    const persisted = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect('pendingSave' in persisted).toBe(false)
    expect(persisted.id).toBe('rev_123_abc')
    expect(getChatSpy).not.toHaveBeenCalled()
  })

  it('does not recreate a chat deleted before a final stream save', async () => {
    const chat = makeChat()
    await chatStorage.saveChat(chat, true)
    saveChatSpy.mockClear()

    isDeletedSpy.mockReturnValue(true)
    await chatStorage.saveChatAndSync({
      ...chat,
      messages: [
        {
          role: 'assistant',
          content: 'Late stream result',
          timestamp: new Date(),
        },
      ],
    })

    expect(saveChatSpy).not.toHaveBeenCalled()
    expect(backupChatSpy).not.toHaveBeenCalled()
  })

  it('queues and dispatches cloud deletion for a memory-only remote chat', async () => {
    getChatSpy.mockResolvedValueOnce(null)

    await chatStorage.deleteChat('memory-only-chat')

    expect(deleteChatWithPendingIntentSpy).toHaveBeenCalledWith(
      'memory-only-chat',
      'delete-key',
      'user-1',
      { forceQueue: true },
    )
    expect(deleteFromCloudSpy).toHaveBeenCalledWith(
      'memory-only-chat',
      'delete-key',
    )
    expect(deleteLocalChatSpy).not.toHaveBeenCalled()
  })

  it('preserves local-only deletion behavior', async () => {
    getChatSpy.mockResolvedValueOnce({ isLocalOnly: true } as never)

    await chatStorage.deleteChat('local-chat')

    expect(deleteLocalChatSpy).toHaveBeenCalledWith('local-chat')
    expect(deleteChatWithPendingIntentSpy).not.toHaveBeenCalled()
    expect(deleteFromCloudSpy).not.toHaveBeenCalled()
  })

  it('does not recreate deleted guest chats in session storage', () => {
    const chat = makeChat()
    sessionChatStorage.saveStreamingDraft(chat)
    isDeletedSpy.mockReturnValue(true)

    sessionChatStorage.saveChat(chat)

    expect(sessionChatStorage.getAllChats()).toEqual([])
  })

  it('does not recreate a deleted guest chat from a late streaming draft', () => {
    const chat = makeChat()
    sessionChatStorage.saveStreamingDraft(chat)
    isDeletedSpy.mockReturnValue(true)

    sessionChatStorage.saveStreamingDraft({
      ...chat,
      messages: [
        { role: 'assistant', content: 'Late result', timestamp: new Date() },
      ],
    })

    expect(sessionChatStorage.getAllChats()).toEqual([])
  })

  it('drops a stale persisted pendingSave when listing chats', async () => {
    getAllChatsSpy.mockResolvedValueOnce([
      {
        id: 'rev_123_abc',
        title: 'Initial Message Test',
        messages: [],
        createdAt: new Date('2026-06-02T09:00:00Z').toISOString(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      },
    ])

    const chats = await chatStorage.getAllChats()

    expect(chats).toHaveLength(1)
    expect('pendingSave' in chats[0]).toBe(false)
  })

  it('drops a stale persisted pendingSave in the sync-status listing', async () => {
    getAllChatsSpy.mockResolvedValueOnce([
      {
        id: 'rev_123_abc',
        title: 'Initial Message Test',
        messages: [],
        createdAt: new Date('2026-06-02T09:00:00Z').toISOString(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      },
    ])

    const chats = await chatStorage.getAllChatsWithSyncStatus()

    expect('pendingSave' in chats[0]).toBe(false)
  })

  it('enumerates every remote project chat before durable local cleanup', async () => {
    listChatIdsByProjectSpy.mockResolvedValueOnce(['remote-1', 'remote-2'])
    deleteChatsByProjectSpy.mockResolvedValue(['remote-1', 'remote-2'])

    await expect(
      chatStorage.deleteChatsByProjectWithIds('project-1'),
    ).resolves.toEqual(['remote-1', 'remote-2'])

    expect(withProjectUploadBarrierSpy).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    )
    expect(listChatIdsByProjectSpy).toHaveBeenCalledWith(
      'project-1',
      expect.any(Object),
    )
    expect(deleteChatsByProjectSpy).toHaveBeenCalledWith(
      'project-1',
      ['remote-1', 'remote-2'],
      'user-1',
      newIdempotencyKeySpy,
      expect.any(Function),
    )
    expect(deleteRemoteProjectChatsSpy).toHaveBeenCalledWith(
      'project-1',
      expect.any(Object),
    )
    expect(acknowledgePendingDeletesSpy).toHaveBeenCalledWith(
      ['remote-1', 'remote-2'],
      'user-1',
      expect.any(Function),
    )
  })

  it('stops before local staging when the account changes during listing', async () => {
    listChatIdsByProjectSpy.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return []
    })

    await expect(chatStorage.deleteChatsByProject('project-1')).rejects.toThrow(
      'Cloud account changed',
    )
    expect(deleteChatsByProjectSpy).not.toHaveBeenCalled()
    expect(deleteRemoteProjectChatsSpy).not.toHaveBeenCalled()
  })

  it('stops before remote deletion when the account changes after staging', async () => {
    deleteChatsByProjectSpy.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return ['local-chat']
    })

    await expect(chatStorage.deleteChatsByProject('project-1')).rejects.toThrow(
      'Cloud account changed',
    )
    expect(deleteRemoteProjectChatsSpy).not.toHaveBeenCalled()
    expect(acknowledgePendingDeletesSpy).not.toHaveBeenCalled()
  })

  it('retains staged intents when the controlplane bulk delete fails', async () => {
    deleteChatsByProjectSpy.mockResolvedValueOnce(['local-chat'])
    deleteRemoteProjectChatsSpy.mockRejectedValueOnce(
      new Error('bulk delete unavailable'),
    )

    await expect(chatStorage.deleteChatsByProject('project-1')).rejects.toThrow(
      'bulk delete unavailable',
    )
    expect(acknowledgePendingDeletesSpy).not.toHaveBeenCalled()
  })

  it('reports completed cloud deletion with local and cloud counts', async () => {
    getAllChatIdsSpy.mockResolvedValueOnce(['local-1', 'local-2'])
    deleteAllChatsSpy.mockResolvedValueOnce(2)
    isCloudAuthenticatedSpy.mockResolvedValueOnce(true)
    deleteAllCloudChatsSpy.mockResolvedValueOnce({ deleted: 3 })

    const result = await chatStorage.deleteAllChats()

    expect(result).toEqual({
      localDeleted: 2,
      cloudDeleted: 3,
      cloudDeletionCompleted: true,
    })
    expect(markAsDeletedSpy).toHaveBeenCalledTimes(2)
  })

  it('reports when cloud deletion is skipped without authentication', async () => {
    deleteAllChatsSpy.mockResolvedValueOnce(2)

    await expect(chatStorage.deleteAllChats()).resolves.toEqual({
      localDeleted: 2,
      cloudDeleted: 0,
      cloudDeletionCompleted: false,
    })
    expect(deleteAllCloudChatsSpy).not.toHaveBeenCalled()
  })
})

describe('chatStorage local-only classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isDeletedSpy.mockReturnValue(false)
  })

  it('stores chats as local-only and skips backup while cloud sync is disabled', async () => {
    setCloudSyncEnabled(false)

    const saved = await chatStorage.saveChat(makeChat({ isLocalOnly: false }))

    const persisted = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect(persisted.isLocalOnly).toBe(true)
    expect(saved.isLocalOnly).toBe(true)
    expect(backupChatSpy).not.toHaveBeenCalled()
  })

  it('keeps cloud chats eligible for backup while cloud sync is enabled', async () => {
    setCloudSyncEnabled(true)

    await chatStorage.saveChat(makeChat({ isLocalOnly: false }))

    const persisted = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect(persisted.isLocalOnly).toBe(false)
    expect(backupChatSpy).toHaveBeenCalledTimes(1)
  })

  it('uses the persisted local-only classification for backup and return state', async () => {
    setCloudSyncEnabled(true)
    saveChatSpy.mockResolvedValueOnce({ saved: true, isLocalOnly: true })

    const saved = await chatStorage.saveChat(makeChat({ isLocalOnly: false }))

    expect(saved.isLocalOnly).toBe(true)
    expect(backupChatSpy).not.toHaveBeenCalled()
  })
})

describe('chatStorage convertChatToLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isDeletedSpy.mockReturnValue(false)
    setCloudSyncEnabled(true)
    setupAccountGuard()
  })

  function syncedImage(
    id: string,
    base64?: string,
    keyField: 'encryptionKey' | 'key' = 'encryptionKey',
  ) {
    return {
      id,
      type: 'image' as const,
      fileName: `${id}.png`,
      mimeType: 'image/png',
      [keyField]: 'k'.repeat(44),
      thumbnailBase64: 'thumb',
      ...(base64 ? { base64 } : {}),
    }
  }

  function chatWithImages(...attachments: ReturnType<typeof syncedImage>[]) {
    return makeChat({
      isLocalOnly: false,
      messages: [
        {
          role: 'user',
          content: 'look',
          timestamp: new Date('2026-06-02T09:00:00Z'),
          attachments,
        },
      ],
    })
  }

  it('keeps synced image bytes locally and drops the bucket key before deleting the cloud row', async () => {
    const chat = chatWithImages(
      syncedImage('att-remote'),
      syncedImage('att-local', 'LOCAL'),
    )
    getChatSpy.mockResolvedValue(chat as unknown)
    loadChatImagesSpy.mockResolvedValueOnce({ 'att-remote': 'FETCHED' })
    mutateChatSpy.mockImplementationOnce(async (_chatId, mutation) => {
      const result = mutation(structuredClone(chat))
      return result.chat
    })

    await chatStorage.convertChatToLocal('rev_123_abc')

    const mutation = mutateChatSpy.mock.calls[0][1]
    const mutated = mutation(structuredClone(chat)) as {
      chat: Chat
      changed: boolean
    }
    expect(mutated.changed).toBe(true)
    expect(mutated.chat.messages[0].attachments).toEqual([
      expect.objectContaining({ id: 'att-remote', base64: 'FETCHED' }),
      expect.objectContaining({ id: 'att-local', base64: 'LOCAL' }),
    ])
    for (const attachment of mutated.chat.messages[0].attachments!) {
      expect(attachment).not.toHaveProperty('encryptionKey')
    }
    expect(mutateChatSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFromCloudSpy.mock.invocationCallOrder[0],
    )
  })

  it('retains legacy inline images and drops their legacy key', async () => {
    const chat = chatWithImages(syncedImage('att-legacy', undefined, 'key'))
    getChatSpy.mockResolvedValue(chat as unknown)
    loadChatImagesSpy.mockResolvedValueOnce({ 'att-legacy': 'FETCHED' })
    mutateChatSpy.mockImplementationOnce(async (_chatId, mutation) => {
      return mutation(structuredClone(chat)).chat
    })

    await chatStorage.convertChatToLocal('rev_123_abc')

    const mutation = mutateChatSpy.mock.calls[0][1]
    const mutated = mutation(structuredClone(chat)) as {
      chat: Chat
      changed: boolean
    }
    const attachment = mutated.chat.messages[0].attachments![0]
    expect(attachment.base64).toBe('FETCHED')
    expect(attachment).not.toHaveProperty('key')
    expect(deleteFromCloudSpy).toHaveBeenCalled()
  })

  it('refuses to convert when a synced image cannot be fetched', async () => {
    const chat = chatWithImages(syncedImage('att-remote'))
    getChatSpy.mockResolvedValue(chat as unknown)
    loadChatImagesSpy.mockResolvedValueOnce({})

    await expect(
      chatStorage.convertChatToLocal('rev_123_abc'),
    ).rejects.toBeInstanceOf(ChatImagesUnavailableError)

    expect(mutateChatSpy).not.toHaveBeenCalled()
    expect(deleteFromCloudSpy).not.toHaveBeenCalled()
    expect(updateChatLocalOnlySpy).not.toHaveBeenCalled()
  })

  it('refuses to convert when an image was added between the fetch and the write', async () => {
    const chat = chatWithImages(syncedImage('att-remote'))
    getChatSpy.mockResolvedValue(chat as unknown)
    loadChatImagesSpy.mockResolvedValueOnce({ 'att-remote': 'FETCHED' })
    const newer = chatWithImages(
      syncedImage('att-remote'),
      syncedImage('att-added-later'),
    )
    mutateChatSpy.mockImplementationOnce(async (_chatId, mutation) => {
      return mutation(structuredClone(newer)).chat
    })

    await expect(
      chatStorage.convertChatToLocal('rev_123_abc'),
    ).rejects.toBeInstanceOf(ChatImagesUnavailableError)

    expect(deleteFromCloudSpy).not.toHaveBeenCalled()
    expect(updateChatLocalOnlySpy).not.toHaveBeenCalled()
  })

  it('aborts when the account changes while images are downloading', async () => {
    const chat = chatWithImages(syncedImage('att-remote'))
    getChatSpy.mockResolvedValue(chat as unknown)
    loadChatImagesSpy.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return { 'att-remote': 'FETCHED' }
    })

    await expect(chatStorage.convertChatToLocal('rev_123_abc')).rejects.toThrow(
      'Cloud account changed',
    )

    expect(mutateChatSpy).not.toHaveBeenCalled()
    expect(deleteFromCloudSpy).not.toHaveBeenCalled()
  })

  it('restores cloud classification when the cloud delete fails', async () => {
    getChatSpy.mockResolvedValue(makeChat({ isLocalOnly: false }) as unknown)
    deleteFromCloudSpy.mockRejectedValueOnce(new Error('network down'))

    await expect(chatStorage.convertChatToLocal('rev_123_abc')).rejects.toThrow(
      'network down',
    )

    // Conversion marked the chat local, then the rollback restored it.
    expect(updateChatLocalOnlySpy).toHaveBeenNthCalledWith(
      1,
      'rev_123_abc',
      true,
    )
    expect(updateChatLocalOnlySpy).toHaveBeenNthCalledWith(
      2,
      'rev_123_abc',
      false,
    )
    const restored = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect(restored.isLocalOnly).toBe(false)
  })
})

describe('chatStorage project move rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
  })

  it('restores the original local chat when the project update fails', async () => {
    const originalChat = makeChat({
      title: 'Original local chat',
      messages: [{ role: 'user', content: 'Keep this message' }],
      isLocalOnly: true,
      projectId: 'original-project',
    })
    const convertedChat = { ...originalChat, isLocalOnly: false }
    getChatSpy
      .mockResolvedValueOnce(originalChat as unknown)
      .mockResolvedValueOnce(originalChat as unknown)
      .mockResolvedValueOnce(convertedChat as unknown)
    updateCloudChatProjectSpy.mockRejectedValueOnce(
      new Error('project update failed'),
    )

    await expect(
      chatStorage.moveChatToProject('rev_123_abc', 'target-project'),
    ).rejects.toThrow('project update failed')

    expect(backupChatNowSpy).toHaveBeenCalledWith('rev_123_abc', {
      restoreDeleted: true,
    })
    expect(deleteFromCloudSpy).toHaveBeenCalledWith('rev_123_abc', 'delete-key')
    expect(saveChatSpy).toHaveBeenLastCalledWith(originalChat)
    expect(chatEventsEmitSpy).toHaveBeenLastCalledWith({
      reason: 'save',
      ids: ['rev_123_abc'],
    })
  })

  it('rolls back when the project chat upload fails', async () => {
    const originalChat = makeChat({
      messages: [{ role: 'user', content: 'Keep this message' }],
      isLocalOnly: true,
      projectId: 'original-project',
    })
    const convertedChat = { ...originalChat, isLocalOnly: false }
    getChatSpy
      .mockResolvedValueOnce(originalChat as unknown)
      .mockResolvedValueOnce(originalChat as unknown)
      .mockResolvedValueOnce(convertedChat as unknown)
    backupChatAndWaitSpy.mockRejectedValueOnce(new Error('upload failed'))

    await expect(
      chatStorage.moveChatToProject('rev_123_abc', 'target-project'),
    ).rejects.toThrow('upload failed')

    expect(backupChatAndWaitSpy).toHaveBeenCalledWith('rev_123_abc')
    expect(deleteFromCloudSpy).toHaveBeenCalledWith('rev_123_abc', 'delete-key')
    expect(saveChatSpy).toHaveBeenLastCalledWith(originalChat)
    expect(chatEventsEmitSpy).toHaveBeenLastCalledWith({
      reason: 'save',
      ids: ['rev_123_abc'],
    })
  })

  it('emits a save event after a successful project move', async () => {
    getChatSpy.mockResolvedValueOnce(makeChat() as unknown)

    await chatStorage.moveChatToProject('rev_123_abc', 'target-project')

    expect(backupChatAndWaitSpy).toHaveBeenCalledWith('rev_123_abc')
    expect(chatEventsEmitSpy).toHaveBeenCalledOnce()
    expect(chatEventsEmitSpy).toHaveBeenCalledWith({
      reason: 'save',
      ids: ['rev_123_abc'],
    })
  })
})

describe('chatStorage forkChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isDeletedSpy.mockReturnValue(false)
    setCloudSyncEnabled(true)
  })

  const storedSource = {
    id: 'rev_123_abc',
    title: 'Trip planning',
    createdAt: '2026-06-02T09:00:00.000Z',
    updatedAt: '2026-06-02T09:05:00.000Z',
    lastAccessedAt: 1,
    syncVersion: 4,
    messages: [
      { role: 'user', content: 'one', timestamp: '2026-06-02T09:00:00.000Z' },
      {
        role: 'assistant',
        content: 'two',
        timestamp: '2026-06-02T09:00:01.000Z',
      },
      { role: 'user', content: 'three', timestamp: '2026-06-02T09:00:02.000Z' },
    ],
  }

  it('copies a local-only chat on this device without touching the cloud', async () => {
    const source = { ...storedSource, isLocalOnly: true }
    getChatSpy.mockImplementation(async (id: unknown) =>
      id === 'rev_123_abc' ? source : (saveChatSpy.mock.calls[0]?.[0] ?? null),
    )

    const fork = await chatStorage.forkChat('rev_123_abc', 2)

    expect(fork.id).not.toBe('rev_123_abc')
    expect(fork.title).toBe('Trip planning (fork)')
    expect(fork.messages.map((m) => m.content)).toEqual(['one', 'two'])
    expect(fork.isLocalOnly).toBe(true)
    const persisted = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect(persisted.id).toBe(fork.id)
    expect(persisted).not.toHaveProperty('syncVersion')
    expect(forkCloudChatSpy).not.toHaveBeenCalled()
    expect(backupChatSpy).not.toHaveBeenCalled()
  })

  it('forks a synced chat through the enclave and returns the stored row', async () => {
    const source = { ...storedSource, isLocalOnly: false }
    getChatSpy.mockImplementation(async (id: unknown) => {
      if (id === 'rev_123_abc') return source
      const request = forkCloudChatSpy.mock.calls[0]?.[0] as
        { targetId: string } | undefined
      return request && id === request.targetId
        ? { ...source, id, title: 'Trip planning (fork)' }
        : null
    })

    const fork = await chatStorage.forkChat('rev_123_abc', 2)

    expect(forkCloudChatSpy).toHaveBeenCalledWith({
      sourceId: 'rev_123_abc',
      targetId: fork.id,
      messageCount: 2,
      title: 'Trip planning (fork)',
    })
    expect(fork.id).not.toBe('rev_123_abc')
    expect(saveChatSpy).not.toHaveBeenCalled()
  })

  it('fails when the source chat does not exist', async () => {
    getChatSpy.mockResolvedValue(null)

    await expect(chatStorage.forkChat('missing', 1)).rejects.toThrow(
      'Chat not found',
    )
    expect(forkCloudChatSpy).not.toHaveBeenCalled()
    expect(saveChatSpy).not.toHaveBeenCalled()
  })
})
