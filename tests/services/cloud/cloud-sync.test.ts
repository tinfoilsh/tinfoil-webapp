import { SYNC_CHAT_STATUS } from '@/constants/storage-keys'
import { CloudSyncService } from '@/services/cloud/cloud-sync'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAllChats = vi.fn()
const mockGetCloudChatCount = vi.fn()
const mockGetUnsyncedChats = vi.fn()
const mockGetChat = vi.fn()
const mockSaveChat = vi.fn()
const mockSaveExistingChat = vi.fn()
const mockMarkAsSynced = vi.fn()
const mockFinalizeUpload = vi.fn()
const mockApplyRemoteChatIfFresh = vi.fn()
const mockRebaseSyncVersion = vi.fn()
const mockResetSyncMetadataForAllChats = vi.fn()
const mockDeleteChat = vi.fn()

const mockIsAuthenticated = vi.fn()
const mockUploadChat = vi.fn()
const mockDownloadChat = vi.fn()
const mockGetChatSyncStatus = vi.fn()
const mockGetAllChatsSyncStatus = vi.fn()
const mockGetAllChatsUpdatedSince = vi.fn()
const mockListChats = vi.fn()

const mockListProjectChats = vi.fn()
const mockGetProjectChatsSyncStatus = vi.fn()

const mockEncryptionInitialize = vi.fn()
const mockGetKey = vi.fn()
const mockRunLegacyBlobMigration = vi.fn()
const mockFinalizeAlternatives = vi.fn()
const mockRunLegacyChatEviction = vi.fn()
const mockKeyCurrent = vi.fn()
const mockPrimaryKeyIdHex = vi.fn()
const mockRegisterKey = vi.fn()
const mockRequirePrimaryKeyB64 = vi.fn()
const mockRequirePrimaryKeyBytes = vi.fn()
const mockPull = vi.fn()
const mockMigrationKeys = vi.fn()
const mockMigrationKeySetFingerprint = vi.fn(async () => null)
const mockGetCachedPrfResult = vi.fn()
const mockDeriveKeyEncryptionKey = vi.fn()
const mockLoadPasskeyCredentials = vi.fn()
const mockWrapCekForCredential = vi.fn()

const mockIsStreaming = vi.fn()
const mockOnStreamEnd = vi.fn()

const mockChatEventsEmit = vi.fn()
const mockReportChatSynced = vi.fn()
const mockReportChatSyncFailed = vi.fn()
const mockReportSyncSuccess = vi.fn()
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
    getCloudChatCount: (...args: any[]) => mockGetCloudChatCount(...args),
    getUnsyncedChats: (...args: any[]) => mockGetUnsyncedChats(...args),
    saveChat: (...args: any[]) => mockSaveChat(...args),
    saveExistingChat: (...args: any[]) => mockSaveExistingChat(...args),
    markAsSynced: (...args: any[]) => mockMarkAsSynced(...args),
    finalizeUpload: (...args: any[]) => mockFinalizeUpload(...args),
    applyRemoteChatIfFresh: (...args: any[]) =>
      mockApplyRemoteChatIfFresh(...args),
    rebaseSyncVersion: (...args: any[]) => mockRebaseSyncVersion(...args),
    resetSyncMetadataForAllChats: (...args: any[]) =>
      mockResetSyncMetadataForAllChats(...args),
    getChat: (...args: any[]) => mockGetChat(...args),
    deleteChat: (...args: any[]) => mockDeleteChat(...args),
  },
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    isAuthenticated: (...args: any[]) => mockIsAuthenticated(...args),
    uploadChat: (...args: any[]) => mockUploadChat(...args),
    downloadChat: (...args: any[]) => mockDownloadChat(...args),
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
    getKey: (...args: any[]) => mockGetKey(...args),
  },
}))

vi.mock('@/services/sync-enclave/sync-api', () => ({
  keyCurrent: (...args: any[]) => mockKeyCurrent(...args),
  newIdempotencyKey: () => 'idem-test-key',
  registerKey: (...args: any[]) => mockRegisterKey(...args),
  pull: (...args: any[]) => mockPull(...args),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  hasPrimaryKey: () => mockGetKey() != null,
  primaryKeyIdHexOrNull: (...args: any[]) => mockPrimaryKeyIdHex(...args),
  requirePrimaryKeyB64: (...args: any[]) => mockRequirePrimaryKeyB64(...args),
  persistedPrimaryKeyB64: (...args: any[]) => mockRequirePrimaryKeyB64(...args),
  requirePrimaryKeyBytes: (...args: any[]) =>
    mockRequirePrimaryKeyBytes(...args),
  migrationKeys: (...args: any[]) => mockMigrationKeys(...args),
  migrationKeySetFingerprint: (...args: any[]) =>
    mockMigrationKeySetFingerprint(...args),
}))

vi.mock('@/services/passkey/passkey-service', () => ({
  getCachedPrfResult: (...args: any[]) => mockGetCachedPrfResult(...args),
  deriveKeyEncryptionKey: (...args: any[]) =>
    mockDeriveKeyEncryptionKey(...args),
}))

vi.mock('@/services/passkey/passkey-key-storage', () => ({
  loadPasskeyCredentials: (...args: any[]) =>
    mockLoadPasskeyCredentials(...args),
}))

vi.mock('@/services/sync-enclave/key-bundle', () => ({
  wrapCekForCredential: (...args: any[]) => mockWrapCekForCredential(...args),
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

vi.mock('@/services/cloud/sync-health', () => ({
  reportChatSynced: (...args: any[]) => mockReportChatSynced(...args),
  reportChatSyncFailed: (...args: any[]) => mockReportChatSyncFailed(...args),
  reportKeyActionRequired: vi.fn(),
  reportSyncPaused: vi.fn(),
  reportSyncSuccess: (...args: any[]) => mockReportSyncSuccess(...args),
}))

vi.mock('@/services/cloud/chat-ingestion', () => ({
  ingestRemoteChats: (...args: any[]) => mockIngestRemoteChats(...args),
  syncRemoteDeletions: (...args: any[]) => mockSyncRemoteDeletions(...args),
}))

vi.mock('@/services/cloud/legacy-blob-migration', () => ({
  runLegacyBlobMigration: (...args: any[]) =>
    mockRunLegacyBlobMigration(...args),
  finalizeAlternativesIfMigrated: (...args: any[]) =>
    mockFinalizeAlternatives(...args),
}))

vi.mock('@/services/cloud/legacy-chat-eviction', () => ({
  runLegacyChatEvictionIfNeeded: (...args: any[]) =>
    mockRunLegacyChatEviction(...args),
}))

describe('CloudSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem(SYNC_CHAT_STATUS)
    mockSaveChat.mockResolvedValue(undefined)
    mockSaveExistingChat.mockResolvedValue(undefined)
    mockMarkAsSynced.mockResolvedValue(undefined)
    mockFinalizeUpload.mockResolvedValue(undefined)
    mockApplyRemoteChatIfFresh.mockResolvedValue({ applied: true })
    mockRebaseSyncVersion.mockResolvedValue(undefined)
    mockResetSyncMetadataForAllChats.mockResolvedValue(undefined)
    mockDeleteChat.mockResolvedValue(undefined)
    mockGetKey.mockReturnValue(null)
    mockKeyCurrent.mockResolvedValue({ key_id: null })
    mockPrimaryKeyIdHex.mockResolvedValue(null)
    mockRegisterKey.mockResolvedValue({ key_id: 'kid-local' })
    mockRequirePrimaryKeyB64.mockReturnValue('cek-b64')
    mockRequirePrimaryKeyBytes.mockReturnValue(new Uint8Array(32))
    mockGetCachedPrfResult.mockReturnValue(null)
    mockLoadPasskeyCredentials.mockResolvedValue([])
    mockDeriveKeyEncryptionKey.mockResolvedValue('kek')
    mockWrapCekForCredential.mockResolvedValue({
      credentialId: 'cred-1',
      kekIvHex: 'iv-hex',
      wrappedKeyHex: 'wrapped-hex',
      saltHex: '',
    })
    mockRunLegacyBlobMigration.mockResolvedValue({
      scopes: [],
      totalMigrated: 0,
      totalRemaining: 0,
      totalBlocked: 0,
      fullyMigrated: true,
    })
    mockFinalizeAlternatives.mockReturnValue(true)
    mockRunLegacyChatEviction.mockResolvedValue(undefined)
    mockIsAuthenticated.mockResolvedValue(true)
    mockUploadChat.mockResolvedValue({ syncVersion: null, rewrites: [] })
    mockDownloadChat.mockResolvedValue(null)
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
      expect(mockFinalizeUpload).not.toHaveBeenCalled()
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
      expect(mockFinalizeUpload).not.toHaveBeenCalled()
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
      expect(mockFinalizeUpload).toHaveBeenCalledTimes(1)
      expect(mockFinalizeUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'cloud-1',
          syncVersion: 8,
          rewrites: [],
        }),
      )
    })

    it('does not enqueue an upload after the account changes', async () => {
      let releaseChat: (() => void) | undefined
      mockGetChat.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseChat = resolve
        })
        return {
          id: 'old-account-chat',
          title: 'Old account',
          messages: [{ role: 'user', content: 'hi' }],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: false,
          syncVersion: 1,
        }
      })

      const service = new CloudSyncService()
      const backup = service.backupChat('old-account-chat')
      await vi.waitFor(() => expect(mockGetChat).toHaveBeenCalled())

      service.resetForAccountChange()
      releaseChat?.()
      await backup

      expect(mockUploadChat).not.toHaveBeenCalled()
    })

    it('does not upload immediately after the account changes', async () => {
      let releaseChat: (() => void) | undefined
      mockGetChat.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseChat = resolve
        })
        return {
          id: 'old-account-chat',
          title: 'Old account',
          messages: [{ role: 'user', content: 'hi' }],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          lastAccessedAt: Date.now(),
          isBlankChat: false,
          isLocalOnly: false,
          syncVersion: 1,
        }
      })

      const service = new CloudSyncService()
      const backup = service.backupChatNow('old-account-chat')
      await vi.waitFor(() => expect(mockGetChat).toHaveBeenCalled())

      service.resetForAccountChange()
      releaseChat?.()
      await backup

      expect(mockUploadChat).not.toHaveBeenCalled()
    })

    it('does not upload when the account changes during worker loading', async () => {
      const chat = {
        id: 'old-account-chat',
        title: 'Old account',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        syncVersion: 1,
      }
      let releaseWorkerLoad: (() => void) | undefined
      mockGetChat
        .mockResolvedValueOnce(chat)
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            releaseWorkerLoad = resolve
          })
          return chat
        })

      const service = new CloudSyncService()
      await service.backupChat('old-account-chat')
      await vi.waitFor(() => expect(mockGetChat).toHaveBeenCalledTimes(2))

      service.resetForAccountChange()
      releaseWorkerLoad?.()
      await Promise.resolve()

      expect(mockUploadChat).not.toHaveBeenCalled()
    })
  })

  describe('backupUnsyncedChats', () => {
    it('filters out local-only, streaming, blank, and failed-decryption chats', async () => {
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
        syncVersion: 3,
      }

      mockGetUnsyncedChats.mockResolvedValue([
        { ...good, id: 'local-only', isLocalOnly: true },
        { ...good, id: 'blank', isBlankChat: true },
        { ...good, id: 'failed', decryptionFailed: true },
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
      expect(mockFinalizeUpload).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'cloud-1', syncVersion: 4 }),
      )
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

    it('forces a full pull when the live local chat count has dropped below the cached snapshot', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockResolvedValue({
        count: 1873,
        lastUpdated: '2026-05-25T18:04:30.182Z',
      })
      mockGetCloudChatCount.mockResolvedValue(6)

      localStorage.setItem(
        SYNC_CHAT_STATUS,
        JSON.stringify({
          count: 1873,
          lastUpdated: '2026-05-25T18:04:30.182Z',
          localCount: 1633,
        }),
      )

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status.needsSync).toBe(true)
      expect(status.reason).toBe('count_changed')
      expect(status.remoteCount).toBe(1873)
    })

    it('stays at no_changes when remote and live local counts both match the cached snapshot', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockResolvedValue({
        count: 1873,
        lastUpdated: '2026-05-25T18:04:30.182Z',
      })
      mockGetCloudChatCount.mockResolvedValue(1633)

      localStorage.setItem(
        SYNC_CHAT_STATUS,
        JSON.stringify({
          count: 1873,
          lastUpdated: '2026-05-25T18:04:30.182Z',
          localCount: 1633,
        }),
      )

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status.needsSync).toBe(false)
      expect(status.reason).toBe('no_changes')
    })

    it('falls back to remote-only comparison when the snapshot predates the localCount field', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetChatSyncStatus.mockResolvedValue({
        count: 12,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      })
      mockGetCloudChatCount.mockResolvedValue(0)

      localStorage.setItem(
        SYNC_CHAT_STATUS,
        JSON.stringify({
          count: 12,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        }),
      )

      const service = new CloudSyncService()
      const status = await service.checkSyncStatus()

      expect(status.needsSync).toBe(false)
      expect(status.reason).toBe('no_changes')
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

    it('fetches only the first page for a default (non-deep) full sync', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({
        conversations: [{ id: 'c1' }],
        hasMore: true,
        nextContinuationToken: 'tok1',
      })

      const service = new CloudSyncService()
      await service.syncAllChats()

      expect(mockListChats).toHaveBeenCalledTimes(1)
      expect(
        mockListChats.mock.calls[0]?.[0]?.continuationToken,
      ).toBeUndefined()
    })

    it('pages through every remote chat when a deep sync is requested', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats
        .mockResolvedValueOnce({
          conversations: [{ id: 'c1' }],
          hasMore: true,
          nextContinuationToken: 'tok1',
        })
        .mockResolvedValueOnce({
          conversations: [{ id: 'c2' }],
          hasMore: true,
          nextContinuationToken: 'tok2',
        })
        .mockResolvedValueOnce({
          conversations: [{ id: 'c3' }],
          hasMore: false,
        })
      mockIngestRemoteChats.mockResolvedValue({
        downloaded: 1,
        errors: [],
        savedIds: ['x'],
      })

      const service = new CloudSyncService()
      const result = await service.syncAllChats({ deep: true })

      expect(mockListChats).toHaveBeenCalledTimes(3)
      expect(
        mockListChats.mock.calls[0]?.[0]?.continuationToken,
      ).toBeUndefined()
      expect(mockListChats.mock.calls[1]?.[0]?.continuationToken).toBe('tok1')
      expect(mockListChats.mock.calls[2]?.[0]?.continuationToken).toBe('tok2')
      // One ingest per fetched page, all counted toward downloaded.
      expect(mockIngestRemoteChats).toHaveBeenCalledTimes(3)
      expect(result.downloaded).toBe(3)
    })

    it('stops deep paging when a page returns no continuation token', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({
        conversations: [{ id: 'only' }],
        hasMore: false,
      })

      const service = new CloudSyncService()
      await service.syncAllChats({ deep: true })

      expect(mockListChats).toHaveBeenCalledTimes(1)
    })

    it('does not repopulate sync status after an account change', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      mockGetChatSyncStatus.mockResolvedValue({
        count: 1,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      })
      let finishCount: ((count: number) => void) | undefined
      mockGetCloudChatCount.mockReturnValue(
        new Promise((resolve) => {
          finishCount = resolve
        }),
      )

      const service = new CloudSyncService()
      const sync = service.syncAllChats()
      await vi.waitFor(() =>
        expect(mockGetCloudChatCount).toHaveBeenCalledTimes(1),
      )

      service.resetForAccountChange()
      finishCount?.(1)
      await sync

      expect(localStorage.getItem(SYNC_CHAT_STATUS)).toBeNull()
      expect(mockReportSyncSuccess).not.toHaveBeenCalled()
    })

    it('does not report a stale sync as healthy', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      mockGetCloudChatCount.mockResolvedValue(0)
      let finishCrossScope:
        | ((status: { count: number; lastUpdated: null }) => void)
        | undefined
      mockGetAllChatsSyncStatus.mockReturnValue(
        new Promise((resolve) => {
          finishCrossScope = resolve
        }),
      )

      const service = new CloudSyncService()
      const sync = service.syncAllChats()
      await vi.waitFor(() =>
        expect(mockGetAllChatsSyncStatus).toHaveBeenCalledTimes(1),
      )

      service.resetForAccountChange()
      finishCrossScope?.({ count: 0, lastUpdated: null })
      await sync

      expect(mockReportSyncSuccess).not.toHaveBeenCalled()
    })

    it('defers the legacy blob migration until the local key is the registered current key', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({
        conversations: [],
        hasMore: false,
      })

      // The migration kick is fire-and-forget, so flush microtasks
      // after each sync before asserting on its async gate.
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
      const service = new CloudSyncService()

      // 1. Keyless device (e.g. a v1->v2 user still waiting on passkey
      // recovery): the migration must not be kicked yet, and the
      // once-per-session latch must not be consumed.
      mockGetKey.mockReturnValue(null)
      await service.syncAllChats()
      await flush()
      expect(mockRunLegacyBlobMigration).not.toHaveBeenCalled()

      // 2. Key loaded locally but not yet registered as the
      // controlplane's current key. migrate-all would storm the rewrap
      // endpoint with 409 stale key, so it must not fire and the latch
      // must stay free for a later retry.
      mockGetKey.mockReturnValue('key_recovered')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null })
      await service.syncAllChats()
      await flush()
      expect(mockRunLegacyBlobMigration).not.toHaveBeenCalled()

      // 3. A different key is registered as current: still a mismatch,
      // still no kick.
      mockKeyCurrent.mockResolvedValue({ key_id: 'kid-other' })
      await service.syncAllChats()
      await flush()
      expect(mockRunLegacyBlobMigration).not.toHaveBeenCalled()

      // 4. Once the local key is the registered current key the
      // migration kicks exactly once.
      mockKeyCurrent.mockResolvedValue({ key_id: 'kid-local' })
      await service.syncAllChats()
      await flush()
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)

      // Subsequent syncs in the same session are a no-op.
      await service.syncAllChats()
      await flush()
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('does not finalize a previous account migration', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: 'kid-local' })
      let finishMigration:
        | ((report: {
            scopes: []
            totalMigrated: number
            totalRemaining: number
            totalBlocked: number
            fullyMigrated: boolean
          }) => void)
        | undefined
      mockRunLegacyBlobMigration.mockReturnValue(
        new Promise((resolve) => {
          finishMigration = resolve
        }),
      )

      const service = new CloudSyncService()
      await service.syncAllChats()
      await vi.waitFor(() =>
        expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1),
      )

      service.resetForAccountChange()
      finishMigration?.({
        scopes: [],
        totalMigrated: 1,
        totalRemaining: 0,
        totalBlocked: 0,
        fullyMigrated: true,
      })
      await Promise.resolve()

      expect(mockFinalizeAlternatives).not.toHaveBeenCalled()
      expect(mockRunLegacyChatEviction).not.toHaveBeenCalled()
    })

    it('adopts the local key so legacy data can migrate without a passkey', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      // v1->v2 user with a local CEK and legacy data on the server, but
      // no registered current key. The CEK is adopted as the current key
      // (bundleless, recovery) so the rewrap gate passes and migration
      // runs — no passkey required, and a legacy passkey wrapping the
      // same CEK would stay promotable afterwards.
      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mockRequirePrimaryKeyB64.mockReturnValue('cek-b64')
      mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])
      mockPull.mockResolvedValue({
        items: [{ id: 'chat-1', ok: true, plaintext: 'cGxhaW4=' }],
      })

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      expect(mockRegisterKey.mock.calls[0]?.[0]).toMatchObject({
        keyB64: 'cek-b64',
        ifMatch: '*',
        createdVia: 'recovery',
      })
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('adopts the local key even when remote rows are sealed under another key', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      // Mixed-key v1 account: legacy rows sealed under several
      // historical keys. Adoption is not gated on a decrypt probe —
      // the migration sweep rewraps only what the key set actually
      // decrypts and leaves the rest on cooldown, so adoption and
      // migration must still run.
      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mockRequirePrimaryKeyB64.mockReturnValue('cek-b64')
      mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])
      mockPull.mockResolvedValue({
        items: [{ id: 'chat-1', ok: false, code: 'UNKNOWN_KEY' }],
      })

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('attaches an initial bundle when a cached PRF matches a stored credential', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])

      const prfOutput = new Uint8Array(32).buffer
      mockGetCachedPrfResult.mockReturnValue({
        credentialId: 'cred-1',
        prfOutput,
      })
      mockLoadPasskeyCredentials.mockResolvedValue([{ id: 'cred-1' }])

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockDeriveKeyEncryptionKey).toHaveBeenCalledWith(prfOutput)
      expect(mockWrapCekForCredential).toHaveBeenCalledWith({
        credentialId: 'cred-1',
        kek: 'kek',
        cek: new Uint8Array(32),
      })
      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      expect(mockRegisterKey.mock.calls[0]?.[0]).toMatchObject({
        keyB64: 'cek-b64',
        createdVia: 'recovery',
        initialBundle: {
          credentialId: 'cred-1',
          kekIvHex: 'iv-hex',
          encryptedKeysHex: 'wrapped-hex',
        },
      })
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('adopts bundleless when the cached PRF credential is not on the account', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])

      // Stale cache: the passkey was deleted or re-created, so the
      // cached credential id no longer appears in the user's stored
      // credentials. Attaching a bundle wrapped under it would make the
      // account look passkey-recoverable when it is not.
      mockGetCachedPrfResult.mockReturnValue({
        credentialId: 'cred-stale',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockLoadPasskeyCredentials.mockResolvedValue([{ id: 'cred-other' }])

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockWrapCekForCredential).not.toHaveBeenCalled()
      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      expect(mockRegisterKey.mock.calls[0]?.[0]).not.toHaveProperty(
        'initialBundle',
      )
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('still adopts the key when bundle building fails', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])

      // The bundle is best-effort: a credentials lookup failure must
      // not block adoption, or the migration gate would never open.
      mockGetCachedPrfResult.mockReturnValue({
        credentialId: 'cred-1',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockLoadPasskeyCredentials.mockRejectedValue(new Error('offline'))

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockRegisterKey).toHaveBeenCalledTimes(1)
      expect(mockRegisterKey.mock.calls[0]?.[0]).not.toHaveProperty(
        'initialBundle',
      )
      expect(mockRunLegacyBlobMigration).toHaveBeenCalledTimes(1)
    })

    it('does not adopt the local key when the server reports no legacy data', async () => {
      mockGetUnsyncedChats.mockResolvedValue([])
      mockGetAllChats.mockResolvedValue([])
      mockListChats.mockResolvedValue({ conversations: [], hasMore: false })
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

      // Local CEK present and no registered key, but the server has no
      // legacy data to migrate (has_data false). Adopting would register
      // a key for a user who has nothing to re-seal, so it must be
      // skipped and migration must not run.
      mockGetKey.mockReturnValue('key_local')
      mockPrimaryKeyIdHex.mockResolvedValue('kid-local')
      mockKeyCurrent.mockResolvedValue({ key_id: null, has_data: false })

      const service = new CloudSyncService()
      await service.syncAllChats()
      await flush()

      expect(mockRegisterKey).not.toHaveBeenCalled()
      expect(mockRunLegacyBlobMigration).not.toHaveBeenCalled()
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

  describe('conflict resolution (last-write-wins by modification time)', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const staleBlob = () =>
      new SyncEnclaveError('stale blob', 409, 'STALE_BLOB')

    const localChat = (updatedAt: string, syncVersion = 1) => ({
      id: 'conflict-1',
      title: 'Conflict',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'newest local turn' },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt,
      syncVersion,
      locallyModified: true,
    })

    it('re-uploads the local copy when it is fresher than the remote', async () => {
      // Local has a later edit than the server snapshot that caused the
      // STALE_BLOB. LWW by time means our edit is the last write, so we
      // must NOT pull the older remote over it.
      mockGetChat.mockResolvedValue(localChat('2024-06-01T00:00:05.000Z', 1))
      mockDownloadChat.mockResolvedValue({
        id: 'conflict-1',
        title: 'Conflict',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
        syncVersion: 7,
      })
      // First upload conflicts; the rebased re-upload succeeds.
      mockUploadChat
        .mockRejectedValueOnce(staleBlob())
        .mockResolvedValue({ syncVersion: 8, rewrites: [] })

      const service = new CloudSyncService()
      await service.backupChat('conflict-1')
      // Drive the conflicting upload and the rebased re-upload, which
      // runs on a fresh coalescer worker after the dirty re-enqueue.
      for (let i = 0; i < 5; i++) {
        await service.waitForUpload('conflict-1')
        await flush()
      }

      // Rebased onto the server's current version so the next If-Match
      // matches, and the local row was never clobbered.
      expect(mockRebaseSyncVersion).toHaveBeenCalledWith('conflict-1', 7)
      expect(mockApplyRemoteChatIfFresh).not.toHaveBeenCalled()
      expect(mockUploadChat).toHaveBeenCalledTimes(2)
    })

    it('overwrites the local copy when the remote is strictly newer', async () => {
      mockGetChat.mockResolvedValue(localChat('2024-06-01T00:00:00.000Z', 1))
      mockDownloadChat.mockResolvedValue({
        id: 'conflict-1',
        title: 'Conflict',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'remote is ahead' },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:10.000Z',
        syncVersion: 9,
      })
      mockUploadChat.mockRejectedValueOnce(staleBlob())

      const service = new CloudSyncService()
      await service.backupChat('conflict-1')
      await service.waitForUpload('conflict-1')
      await flush()

      // The overwrite is bound to the local snapshot we arbitrated
      // against (CAS), not forced, so a TOCTOU edit during the download
      // cannot be clobbered.
      expect(mockApplyRemoteChatIfFresh).toHaveBeenCalledWith(
        expect.objectContaining({
          syncVersion: 9,
          expectedLocalUpdatedAt: '2024-06-01T00:00:00.000Z',
          allowLocallyModified: true,
        }),
      )
      expect(mockChatEventsEmit).toHaveBeenCalledWith({
        reason: 'sync',
        ids: ['conflict-1'],
      })
      // A successful resolution clears any prior failure badge.
      expect(mockReportChatSynced).toHaveBeenCalledWith('conflict-1')
      expect(mockRebaseSyncVersion).not.toHaveBeenCalled()
    })

    it('preserves an interleaved local edit when the CAS no longer matches', async () => {
      mockGetChat.mockResolvedValue(localChat('2024-06-01T00:00:00.000Z', 1))
      mockDownloadChat.mockResolvedValue({
        id: 'conflict-1',
        title: 'Conflict',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'remote is ahead' },
        ],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:10.000Z',
        syncVersion: 9,
      })
      // The local row changed during the remote download, so the CAS
      // ingest reports it did not apply.
      mockApplyRemoteChatIfFresh.mockResolvedValue({ applied: false })
      mockUploadChat.mockRejectedValueOnce(staleBlob())

      const service = new CloudSyncService()
      await service.backupChat('conflict-1')
      await service.waitForUpload('conflict-1')
      await flush()

      // No overwrite event and no synced report: the chat stays
      // locallyModified for the next cycle to re-arbitrate.
      expect(mockChatEventsEmit).not.toHaveBeenCalled()
      expect(mockReportChatSynced).not.toHaveBeenCalled()
    })

    it('leaves the local copy untouched when the remote row is gone', async () => {
      mockGetChat.mockResolvedValue(localChat('2024-06-01T00:00:00.000Z', 1))
      mockDownloadChat.mockResolvedValue(null)
      mockUploadChat.mockRejectedValueOnce(staleBlob())

      const service = new CloudSyncService()
      await service.backupChat('conflict-1')
      await service.waitForUpload('conflict-1')
      await flush()

      expect(mockApplyRemoteChatIfFresh).not.toHaveBeenCalled()
      expect(mockRebaseSyncVersion).not.toHaveBeenCalled()
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

    it('ignores a streaming callback from a previous account', async () => {
      mockIsStreaming.mockReturnValue(true)
      let callback: (() => void) | undefined
      mockOnStreamEnd.mockImplementation((_id: string, onEnd: () => void) => {
        callback = onEnd
      })

      const service = new CloudSyncService()
      await service.backupChat('old-account-chat')
      service.resetForAccountChange()

      mockIsStreaming.mockReturnValue(false)
      callback?.()
      await Promise.resolve()

      expect(mockUploadChat).not.toHaveBeenCalled()
    })

    it('does not finalize an upload after the account changes', async () => {
      const chat = {
        id: 'old-account-chat',
        title: 'Old account',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        isBlankChat: false,
        isLocalOnly: false,
        decryptionFailed: false,
        locallyModified: true,
      }
      mockGetChat.mockResolvedValue(chat)
      let finishUpload:
        | ((value: { syncVersion: number; rewrites: [] }) => void)
        | undefined
      mockUploadChat.mockReturnValue(
        new Promise((resolve) => {
          finishUpload = resolve
        }),
      )

      const service = new CloudSyncService()
      await service.backupChat('old-account-chat')
      await vi.waitFor(() => expect(mockUploadChat).toHaveBeenCalledTimes(1))

      service.resetForAccountChange()
      finishUpload?.({ syncVersion: 2, rewrites: [] })
      await Promise.resolve()

      expect(mockFinalizeUpload).not.toHaveBeenCalled()
      expect(mockReportChatSynced).not.toHaveBeenCalled()
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
      const resolvers: Array<
        (value: { syncVersion: number | null; rewrites: never[] }) => void
      > = []
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
      resolvers[0]?.({ syncVersion: null, rewrites: [] })

      await backup1

      // Wait and resolve second
      await new Promise((resolve) => setTimeout(resolve, 10))
      resolvers[1]?.({ syncVersion: null, rewrites: [] })

      await backup2

      // Should have uploaded twice (original + queued re-run)
      expect(mockUploadChat).toHaveBeenCalledTimes(2)
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

      expect(mockFinalizeUpload).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'cloud-1', syncVersion: 6 }),
      )
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
      expect(mockFinalizeUpload).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'cloud-1', syncVersion: 1 }),
      )
    })
  })
})
