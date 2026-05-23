import { SYNC_CHAT_STATUS } from '@/constants/storage-keys'
import { CloudSyncService } from '@/services/cloud/cloud-sync'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAllChats = vi.fn()
const mockGetUnsyncedChats = vi.fn()
const mockGetChat = vi.fn()
const mockSaveChat = vi.fn()
const mockSaveExistingChat = vi.fn()
const mockMarkAsSynced = vi.fn()
const mockDeleteChat = vi.fn()

const mockIsAuthenticated = vi.fn()
const mockUploadChat = vi.fn()
const mockGetChatSyncStatus = vi.fn()
const mockGetAllChatsSyncStatus = vi.fn()
const mockGetAllChatsUpdatedSince = vi.fn()
const mockListChats = vi.fn()

const mockListProjectChats = vi.fn()
const mockGetProjectChatsSyncStatus = vi.fn()

const mockEncryptionInitialize = vi.fn()

const mockIsStreaming = vi.fn()
const mockOnStreamEnd = vi.fn()

const mockChatEventsEmit = vi.fn()
const mockIngestRemoteChats = vi.fn()
const mockSyncRemoteDeletions = vi.fn()
const mockCanWriteToCloud = vi.fn()

vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getAllChats: (...args: any[]) => mockGetAllChats(...args),
    getUnsyncedChats: (...args: any[]) => mockGetUnsyncedChats(...args),
    saveChat: (...args: any[]) => mockSaveChat(...args),
    saveExistingChat: (...args: any[]) => mockSaveExistingChat(...args),
    markAsSynced: (...args: any[]) => mockMarkAsSynced(...args),
    getChat: (...args: any[]) => mockGetChat(...args),
    deleteChat: (...args: any[]) => mockDeleteChat(...args),
  },
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    isAuthenticated: (...args: any[]) => mockIsAuthenticated(...args),
    uploadChat: (...args: any[]) => mockUploadChat(...args),
    getChatSyncStatus: (...args: any[]) => mockGetChatSyncStatus(...args),
    getAllChatsSyncStatus: (...args: any[]) =>
      mockGetAllChatsSyncStatus(...args),
    getAllChatsUpdatedSince: (...args: any[]) =>
      mockGetAllChatsUpdatedSince(...args),
    listChats: (...args: any[]) => mockListChats(...args),
  },
}))

vi.mock('@/services/cloud/project-storage', () => ({
  projectStorage: {
    listProjectChats: (...args: any[]) => mockListProjectChats(...args),
    getProjectChatsSyncStatus: (...args: any[]) =>
      mockGetProjectChatsSyncStatus(...args),
  },
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: (...args: any[]) => mockCanWriteToCloud(...args),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    initialize: (...args: any[]) => mockEncryptionInitialize(...args),
  },
}))

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    isStreaming: (...args: any[]) => mockIsStreaming(...args),
    onStreamEnd: (...args: any[]) => mockOnStreamEnd(...args),
  },
}))

vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: {
    emit: (...args: any[]) => mockChatEventsEmit(...args),
  },
}))

vi.mock('@/services/cloud/chat-ingestion', () => ({
  ingestRemoteChats: (...args: any[]) => mockIngestRemoteChats(...args),
  syncRemoteDeletions: (...args: any[]) => mockSyncRemoteDeletions(...args),
}))

describe('CloudSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem(SYNC_CHAT_STATUS)
    mockSaveChat.mockResolvedValue(undefined)
    mockSaveExistingChat.mockResolvedValue(undefined)
    mockMarkAsSynced.mockResolvedValue(undefined)
    mockDeleteChat.mockResolvedValue(undefined)
    mockIsAuthenticated.mockResolvedValue(true)
    mockUploadChat.mockResolvedValue(null)
    mockGetChatSyncStatus.mockResolvedValue({ count: 0, lastUpdated: null })
    mockGetAllChatsSyncStatus.mockResolvedValue({
      count: 0,
      lastUpdated: null,
    })
    mockGetAllChatsUpdatedSince.mockResolvedValue({
      conversations: [],
      hasMore: false,
    })
    mockListChats.mockResolvedValue({
      conversations: [],
      hasMore: false,
    })
    mockListProjectChats.mockResolvedValue({
      chats: [],
      hasMore: false,
    })
    mockGetProjectChatsSyncStatus.mockResolvedValue({
      count: 0,
      lastUpdated: null,
    })
    mockEncryptionInitialize.mockResolvedValue(null)
    mockIsStreaming.mockReturnValue(false)
    mockOnStreamEnd.mockImplementation(() => {})
    mockIngestRemoteChats.mockResolvedValue({
      downloaded: 0,
      errors: [],
      savedIds: [],
    })
    mockCanWriteToCloud.mockResolvedValue(true)
    mockSyncRemoteDeletions.mockResolvedValue(undefined)
  })

  describe('reencryptAndUploadChats', () => {
    it('does not upload local-only chats', async () => {
      mockGetAllChats.mockResolvedValue([
        {
          id: 'local-only-1',
          title: 'Local only',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: true,
          decryptionFailed: false,
          encryptedData: undefined,
          syncVersion: 10,
        },
        {
          id: 'cloud-1',
          title: 'Cloud',
          messages: [],
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: false,
          decryptionFailed: false,
          encryptedData: undefined,
          syncVersion: 1,
        },
      ])

      const service = new CloudSyncService()
      const result = await service.reencryptAndUploadChats()

      expect(mockUploadChat).toHaveBeenCalledTimes(1)
      expect(mockUploadChat.mock.calls[0]?.[0]?.id).toBe('cloud-1')

      // We persist the chat (with bumped syncVersion) only for the one we upload
      expect(mockSaveChat).toHaveBeenCalledTimes(1)
      expect(mockSaveChat.mock.calls[0]?.[0]?.id).toBe('cloud-1')
      expect(mockMarkAsSynced).toHaveBeenCalledTimes(1)

      expect(result.uploaded).toBe(1)
      expect(result.reencrypted).toBe(1)
      expect(result.errors).toEqual([])
    })
  })

  describe('backupChat', () => {
    it('skips local-only chats', async () => {
      mockGetChat.mockResolvedValue({
        id: 'local-only-1',
        title: 'Local only',
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: true,
        syncVersion: 2,
      })

      const service = new CloudSyncService()
      await service.backupChat('local-only-1')

      expect(mockUploadChat).not.toHaveBeenCalled()
      expect(mockMarkAsSynced).not.toHaveBeenCalled()
    })

    it('skips blank chats', async () => {
      mockGetChat.mockResolvedValue({
        id: 'blank-1',
        title: '',
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: true,
        isLocalOnly: false,
        syncVersion: 2,
      })

      const service = new CloudSyncService()
      await service.backupChat('blank-1')

      expect(mockUploadChat).not.toHaveBeenCalled()
      expect(mockMarkAsSynced).not.toHaveBeenCalled()
    })

    it('marks chat as synced with incremented version on success', async () => {
      mockGetChat.mockResolvedValue({
        id: 'cloud-1',
        title: 'Cloud',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        syncVersion: 7,
      })

      const service = new CloudSyncService()
      await service.backupChat('cloud-1')
      // Wait for the coalesced upload to complete
      await service.waitForUpload('cloud-1')

      expect(mockUploadChat).toHaveBeenCalledTimes(1)
      expect(mockMarkAsSynced).toHaveBeenCalledTimes(1)
      expect(mockMarkAsSynced).toHaveBeenCalledWith('cloud-1', 8)
    })
  })

  describe('backupUnsyncedChats', () => {
    it('filters out local-only, streaming, blank, failed-decryption and encryptedData chats', async () => {
      const good = {
        id: 'cloud-1',
        title: 'Good',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        decryptionFailed: false,
        encryptedData: undefined,
        syncVersion: 3,
      }

      mockGetUnsyncedChats.mockResolvedValue([
        { ...good, id: 'local-only', isLocalOnly: true },
        { ...good, id: 'blank', isBlankChat: true },
        { ...good, id: 'failed', decryptionFailed: true },
        { ...good, id: 'encrypted', encryptedData: '{"x":"y"}' },
        { ...good, id: 'streaming' },
        good,
      ])

      // doBackupChat re-reads the chat from IndexedDB
      mockGetChat.mockImplementation((id: string) =>
        id === 'cloud-1' ? Promise.resolve(good) : Promise.resolve(undefined),
      )

      mockIsStreaming.mockImplementation((id: string) => id === 'streaming')

      const service = new CloudSyncService()
      const result = await service.backupUnsyncedChats()

      expect(mockUploadChat).toHaveBeenCalledTimes(1)
      expect(mockUploadChat.mock.calls[0]?.[0]?.id).toBe('cloud-1')
      expect(mockMarkAsSynced).toHaveBeenCalledWith('cloud-1', 4)
      expect(result.uploaded).toBe(1)
      expect(result.errors).toEqual([])
    })
  })

  describe('checkSyncStatus', () => {
    it('returns no_changes when not authenticated', async () => {
      mockIsAuthenticated.mockResolvedValue(false)

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status).toEqual({ needsSync: false, reason: 'no_changes' })
      expect(mockGetUnsyncedChats).not.toHaveBeenCalled()
    })

    it('returns local_changes when there are unsynced non-local chats', async () => {
      mockGetUnsyncedChats.mockResolvedValue([
        { id: 'local-only', isLocalOnly: true, isBlankChat: false },
        { id: 'blank', isLocalOnly: false, isBlankChat: true },
        { id: 'streaming', isLocalOnly: false, isBlankChat: false },
        { id: 'good', isLocalOnly: false, isBlankChat: false },
      ])
      mockIsStreaming.mockImplementation((id: string) => id === 'streaming')

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status).toEqual({ needsSync: true, reason: 'local_changes' })
      expect(mockGetChatSyncStatus).not.toHaveBeenCalled()
    })

    it('returns count_changed when there is no cached status', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockResolvedValue({
        count: 5,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      })

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status.needsSync).toBe(true)
      expect(status.reason).toBe('count_changed')
      expect(status.remoteCount).toBe(5)
      expect(status.remoteLastUpdated).toBe('2024-01-01T00:00:00.000Z')
    })

    it('returns no_changes when cached status matches remote status and there are no local changes', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockResolvedValue({
        count: 5,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      })

      localStorage.setItem(
        SYNC_CHAT_STATUS,
        JSON.stringify({
          count: 5,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        }),
      )

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status.needsSync).toBe(false)
      expect(status.reason).toBe('no_changes')
      expect(status.remoteCount).toBe(5)
      expect(status.remoteLastUpdated).toBe('2024-01-01T00:00:00.000Z')
    })

    it('filters out project chats when checking non-project sync status', async () => {
      mockGetUnsyncedChats.mockResolvedValue([
        {
          id: 'project-chat',
          projectId: 'proj-123',
          isLocalOnly: false,
          isBlankChat: false,
        },
      ])

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus() // No projectId = regular chats only

      // Project chat should be filtered out, so no local changes
      expect(status.reason).not.toBe('local_changes')
    })

    it('only considers project chats when projectId is provided', async () => {
      mockGetUnsyncedChats.mockResolvedValue([
        {
          id: 'project-chat',
          projectId: 'proj-123',
          isLocalOnly: false,
          isBlankChat: false,
        },
        { id: 'regular-chat', isLocalOnly: false, isBlankChat: false },
      ])

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus('proj-123')

      // Should detect local_changes from proj-123 chat
      expect(status).toEqual({ needsSync: true, reason: 'local_changes' })
    })

    it('returns error when getChatSyncStatus throws', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockRejectedValue(new Error('Network error'))

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status).toEqual({ needsSync: true, reason: 'error' })
    })
  })

  describe('syncAllChats', () => {
    it('retries listing remote chats before succeeding', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats
        .mockRejectedValueOnce(new Error('temporary auth failure'))
        .mockResolvedValue({
          conversations: [],
          hasMore: false,
        })

      const service = new CloudSyncService()
      const result = await service.syncAllChats()

      expect(mockListChats).toHaveBeenCalledTimes(2)
      expect(result).toEqual({ uploaded: 0, downloaded: 0, errors: [] })
    })

    it('throws when remote chat listing still fails after retry', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockListChats.mockRejectedValue(new Error('still failing'))

      const service = new CloudSyncService()

      await expect(service.syncAllChats()).rejects.toThrow('still failing')
      expect(mockListChats).toHaveBeenCalledTimes(2)
    })
  })

  describe('syncProjectChats', () => {
    it('retries listing project chats before succeeding', async () => {
      mockGetAllChats.mockResolvedValue([])
      mockListProjectChats
        .mockRejectedValueOnce(new Error('temporary auth failure'))
        .mockResolvedValue({
          chats: [],
          hasMore: false,
        })

      const service = new CloudSyncService()
      const result = await service.syncProjectChats('project-1')

      expect(mockListProjectChats).toHaveBeenCalledTimes(2)
      expect(result).toEqual({ uploaded: 0, downloaded: 0, errors: [] })
    })
  })

  describe('streaming interaction with backupChat', () => {
    it('defers backup when chat is streaming and executes after stream ends', async () => {
      const chat = {
        id: 'streaming-chat',
        title: 'Streaming',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        syncVersion: 1,
      }

      mockGetChat.mockResolvedValue(chat)
      mockIsStreaming.mockReturnValue(true)

      const callbacks: Array<() => void> = []
      mockOnStreamEnd.mockImplementation(
        (_id: string, callback: () => void) => {
          callbacks.push(callback)
        },
      )

      const service = new CloudSyncService()
      await service.backupChat('streaming-chat')

      // Should NOT upload while streaming
      expect(mockUploadChat).not.toHaveBeenCalled()

      // Should have registered a callback
      expect(mockOnStreamEnd).toHaveBeenCalledWith(
        'streaming-chat',
        expect.any(Function),
      )

      // Now simulate stream ending
      mockIsStreaming.mockReturnValue(false)
      callbacks.forEach((cb) => cb())

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Now should have uploaded
      expect(mockUploadChat).toHaveBeenCalledTimes(1)
    })

    it('does not register duplicate streaming callbacks for same chat', async () => {
      mockIsStreaming.mockReturnValue(true)
      mockOnStreamEnd.mockImplementation(() => {})

      const service = new CloudSyncService()

      // Call backupChat twice for same streaming chat
      await service.backupChat('streaming-dup')
      await service.backupChat('streaming-dup')

      // Should only register one callback
      expect(mockOnStreamEnd).toHaveBeenCalledTimes(1)
    })
  })

  describe('upload queue behavior', () => {
    it('chains uploads for the same chat ID', async () => {
      const chat = {
        id: 'queued-chat',
        title: 'Queued',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        syncVersion: 1,
      }

      mockGetChat.mockResolvedValue(chat)

      // Make uploadChat slow so we can queue multiple calls
      const resolvers: Array<(value: null) => void> = []
      mockUploadChat.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )

      const service = new CloudSyncService()

      // Start first backup (will hang)
      const backup1 = service.backupChat('queued-chat')

      // Start second backup (should queue)
      const backup2 = service.backupChat('queued-chat')

      // Resolve first upload
      await new Promise((resolve) => setTimeout(resolve, 10))
      resolvers[0]?.(null)

      await backup1

      // Wait and resolve second
      await new Promise((resolve) => setTimeout(resolve, 10))
      resolvers[1]?.(null)

      await backup2

      // Should have uploaded twice (original + queued re-run)
      expect(mockUploadChat).toHaveBeenCalledTimes(2)
    })
  })

  describe('reencryptAndUploadChats edge cases', () => {
    it('skips chats that failed to decrypt', async () => {
      mockGetAllChats.mockResolvedValue([
        {
          id: 'failed-decrypt',
          title: 'Encrypted',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: false,
          decryptionFailed: true,
          encryptedData: '{"encrypted":"data"}',
          syncVersion: 1,
        },
      ])

      const service = new CloudSyncService()
      const result = await service.reencryptAndUploadChats()

      expect(mockUploadChat).not.toHaveBeenCalled()
      expect(result.uploaded).toBe(0)
      expect(result.reencrypted).toBe(0)
    })

    it('skips blank chats during re-encryption', async () => {
      mockGetAllChats.mockResolvedValue([
        {
          id: 'blank-chat',
          title: '',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: true,
          isLocalOnly: false,
          syncVersion: 1,
        },
      ])

      const service = new CloudSyncService()
      const result = await service.reencryptAndUploadChats()

      expect(mockUploadChat).not.toHaveBeenCalled()
      expect(result.uploaded).toBe(0)
    })

    it('skips chats with encryptedData that need decryption first', async () => {
      mockGetAllChats.mockResolvedValue([
        {
          id: 'needs-decrypt',
          title: 'Encrypted',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: false,
          decryptionFailed: false,
          encryptedData: '{"still":"encrypted"}',
          syncVersion: 1,
        },
      ])

      const service = new CloudSyncService()
      const result = await service.reencryptAndUploadChats()

      expect(mockUploadChat).not.toHaveBeenCalled()
      expect(result.uploaded).toBe(0)
    })
  })

  describe('Sync eligibility - comprehensive filtering', () => {
    /**
     * Tests documenting all the conditions that make a chat ineligible for upload.
     * These tests serve as a specification for the sync-predicates module.
     */

    const uploadableChat = {
      id: 'uploadable',
      title: 'Uploadable Chat',
      messages: [{ role: 'user', content: 'test' }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      lastAccessedAt: Date.now(),
      isBlankChat: false,
      isLocalOnly: false,
      decryptionFailed: false,
      encryptedData: undefined,
      syncVersion: 1,
    }

    describe('backupUnsyncedChats filtering', () => {
      it('uploads only eligible chats from a mixed batch', async () => {
        mockGetUnsyncedChats.mockResolvedValue([
          // Eligible
          { ...uploadableChat, id: 'eligible-1' },
          { ...uploadableChat, id: 'eligible-2' },

          // Not eligible - various reasons
          { ...uploadableChat, id: 'local-only', isLocalOnly: true },
          { ...uploadableChat, id: 'blank', isBlankChat: true, messages: [] },
          { ...uploadableChat, id: 'decrypt-failed', decryptionFailed: true },
          {
            ...uploadableChat,
            id: 'has-encrypted-data',
            encryptedData: '{"iv":"x"}',
          },
          { ...uploadableChat, id: 'streaming' },
        ])

        mockIsStreaming.mockImplementation((id: string) => id === 'streaming')

        const service = new CloudSyncService()
        const result = await service.backupUnsyncedChats()

        expect(mockUploadChat).toHaveBeenCalledTimes(2)
        expect(result.uploaded).toBe(2)
      })

      it('handles empty unsynced chats list', async () => {
        mockGetUnsyncedChats.mockResolvedValue([])

        const service = new CloudSyncService()
        const result = await service.backupUnsyncedChats()

        expect(mockUploadChat).not.toHaveBeenCalled()
        expect(result.uploaded).toBe(0)
      })

      it('handles all chats being ineligible', async () => {
        mockGetUnsyncedChats.mockResolvedValue([
          { ...uploadableChat, id: 'local-1', isLocalOnly: true },
          { ...uploadableChat, id: 'local-2', isLocalOnly: true },
          { ...uploadableChat, id: 'blank-1', isBlankChat: true },
        ])

        const service = new CloudSyncService()
        const result = await service.backupUnsyncedChats()

        expect(mockUploadChat).not.toHaveBeenCalled()
        expect(result.uploaded).toBe(0)
      })
    })

    describe('Project chat filtering', () => {
      it('filters by projectId when checking project sync status', async () => {
        mockGetUnsyncedChats.mockResolvedValue([
          { ...uploadableChat, id: 'project-a-chat', projectId: 'project-a' },
          { ...uploadableChat, id: 'project-b-chat', projectId: 'project-b' },
          { ...uploadableChat, id: 'no-project-chat' },
        ])

        const service = new CloudSyncService()

        // Check status for project-a only
        const statusA = await service.checkSyncStatus('project-a')
        expect(statusA.needsSync).toBe(true)
        expect(statusA.reason).toBe('local_changes')

        // Check status for non-existent project
        const statusC = await service.checkSyncStatus('project-c')
        expect(statusC.reason).not.toBe('local_changes')
      })

      it('excludes project chats when checking regular sync status', async () => {
        mockGetUnsyncedChats.mockResolvedValue([
          { ...uploadableChat, id: 'project-chat', projectId: 'some-project' },
        ])

        const service = new CloudSyncService()

        // Regular sync status should not see project chats
        const status = await service.checkSyncStatus()
        expect(status.reason).not.toBe('local_changes')
      })
    })
  })

  describe('Error handling', () => {
    /**
     * Note: Error handling tests for backupChat are complex due to the internal
     * promise chaining and upload queue. The error propagation behavior will be
     * better tested after the Phase 4 upload-coalescer refactor.
     *
     * For now, we document the expected behavior:
     * - Upload failures should not mark chats as synced
     * - backupUnsyncedChats should continue processing other chats after failures
     */

    it('handles missing chat gracefully', async () => {
      mockGetChat.mockResolvedValue(null)

      const service = new CloudSyncService()

      // Should not throw, just return silently
      await service.backupChat('nonexistent-chat')

      expect(mockUploadChat).not.toHaveBeenCalled()
    })

    it('handles not authenticated state gracefully', async () => {
      mockIsAuthenticated.mockResolvedValue(false)

      const service = new CloudSyncService()

      // Should not throw, just return silently
      await service.backupChat('some-chat')

      // Should not even fetch the chat
      expect(mockGetChat).not.toHaveBeenCalled()
      expect(mockUploadChat).not.toHaveBeenCalled()
    })
  })

  describe('Sync version handling', () => {
    it('increments syncVersion on successful upload', async () => {
      mockGetChat.mockResolvedValue({
        id: 'cloud-1',
        title: 'Cloud',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        syncVersion: 5,
      })

      const service = new CloudSyncService()
      await service.backupChat('cloud-1')
      // Wait for the coalesced upload to complete
      await service.waitForUpload('cloud-1')

      expect(mockMarkAsSynced).toHaveBeenCalledWith('cloud-1', 6)
    })

    it('defaults syncVersion to 1 when not present', async () => {
      mockGetChat.mockResolvedValue({
        id: 'cloud-1',
        title: 'Cloud',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        // No syncVersion
      })

      const service = new CloudSyncService()
      await service.backupChat('cloud-1')
      // Wait for the coalesced upload to complete
      await service.waitForUpload('cloud-1')

      // Should increment from default 0 to 1
      expect(mockMarkAsSynced).toHaveBeenCalledWith('cloud-1', 1)
    })
  })
})
