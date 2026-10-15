import { resetRendererRegistry } from '@/components/chat/renderers'
import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACCOUNT_RESET_SIGNAL,
  AUTH_ACTIVE_USER_ID,
  SETTINGS_HAS_SEEN_ONBOARDING,
  USER_ENCRYPTION_KEY,
  USER_PREFS_PINNED_CHAT_IDS,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import { encryptionService } from '@/services/encryption/encryption-service'
import { getView, harnessAPI, publish } from '@/services/harness/runtime'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  IndexedDBStorage,
  indexedDBStorage,
} from '@/services/storage/indexed-db'
import {
  performSignoutCleanup,
  performUserSwitchCleanup,
  retryFailedStorageCleanup,
} from '@/utils/signout-cleanup'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/renderers', () => ({
  resetRendererRegistry: vi.fn(),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const ACCOUNT_KEY = `key_${'ar'.repeat(32)}`

// Local chats are written through a separate connection, as another page
// load would; the cleanup clears them through the app's own store.
async function seedLocalChat(id: string): Promise<void> {
  await new IndexedDBStorage().saveChat({
    id,
    title: 'Private local chat',
    messages: [
      {
        role: 'user',
        content: 'Only on this device',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isLocalOnly: true,
  })
}

const storedChatIds = () => new IndexedDBStorage().getAllChatIds()

function holdStorageReset() {
  let finish!: () => void
  let fail!: (error: unknown) => void
  const held = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const reset = vi
    .spyOn(indexedDBStorage, 'resetForAccountChange')
    .mockReturnValue(held)
  return { reset, finish, fail }
}

async function withPinnedChatChanges(
  action: () => Promise<void>,
  assertion: (handlePinnedChatsChanged: ReturnType<typeof vi.fn>) => void,
): Promise<void> {
  const handlePinnedChatsChanged = vi.fn()
  window.addEventListener(
    PINNED_CHAT_IDS_CHANGED_EVENT,
    handlePinnedChatsChanged,
  )
  try {
    await action()
    assertion(handlePinnedChatsChanged)
  } finally {
    window.removeEventListener(
      PINNED_CHAT_IDS_CHANGED_EVENT,
      handlePinnedChatsChanged,
    )
  }
}

beforeEach(() => {
  vi.mocked(resetRendererRegistry).mockReset()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
  deletedChatsTracker.clear()
  authTokenManager.reset()
  encryptionService.clearKey()
  sessionStorage.clear()
})

afterEach(() => {
  authTokenManager.reset()
  encryptionService.clearKey()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('performSignoutCleanup', () => {
  it.each([false, true])(
    'preserves confirmed sign-out during cleanup with preserveEncryptionKey: %s',
    async (preserveEncryptionKey) => {
      authTokenManager.initialize(null)

      await performSignoutCleanup({ preserveEncryptionKey })

      expect(authTokenManager.isInitialized()).toBe(true)
      expect(authTokenManager.isSignedOut()).toBe(true)
      await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
        reason: 'unavailable',
      })
    },
  )

  it('clears the key, harness, caches, and local chats of the signed-out account', async () => {
    const api = harnessAPI()
    publish({ profile: { nickname: 'Private' } })
    await encryptionService.setKey(ACCOUNT_KEY)
    await seedLocalChat('local-1')
    deletedChatsTracker.markAsDeleted('deleted-1')
    expect(await storedChatIds()).toEqual(['local-1'])

    await performSignoutCleanup()

    expect(api.lifetime.signal.aborted).toBe(true)
    expect(getView().profile).toEqual({})
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    expect(() => encryptionService.getKeyBytesOrThrow()).toThrow()
    expect(resetRendererRegistry).toHaveBeenCalledOnce()
    expect(deletedChatsTracker.getDeletedIds()).toEqual([])
    expect(await storedChatIds()).toEqual([])
  })

  it('tells other tabs to clear their local data', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem')

    await performSignoutCleanup()

    expect(setItem).toHaveBeenCalledWith(
      AUTH_ACCOUNT_RESET_SIGNAL,
      expect.any(String),
    )
    expect(localStorage.getItem(AUTH_ACCOUNT_RESET_SIGNAL)).toBeNull()
  })

  it('keeps the encryption key when preserveEncryptionKey is set', async () => {
    await encryptionService.setKey(ACCOUNT_KEY)
    localStorage.setItem('private-chat-state', 'old-account-data')

    await performSignoutCleanup({ preserveEncryptionKey: true })

    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(ACCOUNT_KEY)
    expect(encryptionService.getKey()).toBe(ACCOUNT_KEY)
    expect(encryptionService.getKeyBytesOrThrow()).toHaveLength(32)
    expect(localStorage.getItem('private-chat-state')).toBeNull()
  })

  it('preserves the browser onboarding flag while clearing user data', async () => {
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    localStorage.setItem('user-specific-data', 'value')

    await performSignoutCleanup()

    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBe('true')
    expect(localStorage.getItem('user-specific-data')).toBeNull()
  })

  it('clears sessionStorage', async () => {
    sessionStorage.setItem('harness-run:alice', 'routing')

    await performSignoutCleanup()

    expect(sessionStorage.getItem('harness-run:alice')).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  it('clears pinned chats from storage and active UI state', async () => {
    localStorage.setItem(USER_PREFS_PINNED_CHAT_IDS, '["chat-a"]')

    await withPinnedChatChanges(performSignoutCleanup, (handle) => {
      expect(localStorage.getItem(USER_PREFS_PINNED_CHAT_IDS)).toBeNull()
      expect(handle).toHaveBeenCalledTimes(1)
      expect(handle.mock.calls[0][0].detail).toEqual({ pinnedChatIds: [] })
    })
  })

  it('keeps the active-user marker until browser data is cleared', async () => {
    const storage = holdStorageReset()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const cleanup = performSignoutCleanup()
    try {
      await vi.waitFor(() => expect(storage.reset).toHaveBeenCalledOnce())
      expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
    } finally {
      storage.finish()
      await cleanup
    }

    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBeNull()
  })

  it('keeps the active-user marker when browser data cannot be cleared', async () => {
    const storage = holdStorageReset()
    const failure = new Error('Failed to reset IndexedDB for account change')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    await withPinnedChatChanges(
      async () => {
        const cleanup = performSignoutCleanup()
        await vi.waitFor(() => expect(storage.reset).toHaveBeenCalledOnce())
        storage.fail(failure)
        await expect(cleanup).rejects.toBe(failure)
      },
      (handle) => expect(handle).toHaveBeenCalledTimes(1),
    )

    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
  })
})

describe('performUserSwitchCleanup', () => {
  it('aborts the old harness and removes account data, local chats included', async () => {
    const api = harnessAPI()
    publish({ profile: { nickname: 'Private' } })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
    localStorage.setItem(USER_ENCRYPTION_KEY, 'key_private')
    sessionStorage.setItem('harness-run:alice', 'routing')
    await seedLocalChat('alice-local')

    await performUserSwitchCleanup('bob')

    expect(api.lifetime.signal.aborted).toBe(true)
    expect(getView().profile).toEqual({})
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('bob')
    expect(sessionStorage.length).toBe(0)
    expect(await storedChatIds()).toEqual([])
  })

  it('revokes the signed-in token getter', async () => {
    const getToken = vi.fn(async () => 'old-account-token')
    authTokenManager.initialize(getToken)

    await performUserSwitchCleanup('user_new')

    expect(authTokenManager.isInitialized()).toBe(false)
    expect(authTokenManager.isSignedOut()).toBe(false)
    await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
      reason: 'not-initialized',
    })
    expect(getToken).not.toHaveBeenCalled()
  })

  it('does not dispatch pinned-chat changes', async () => {
    await withPinnedChatChanges(
      () => performUserSwitchCleanup('user_new'),
      (handle) => expect(handle).not.toHaveBeenCalled(),
    )
  })

  it('surfaces cleanup failures without replacing the marker', async () => {
    const storage = holdStorageReset()
    const failure = new Error('IndexedDB account reset was aborted')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_old')

    const cleanup = performUserSwitchCleanup('user_new')
    await vi.waitFor(() => expect(storage.reset).toHaveBeenCalledOnce())
    storage.fail(failure)

    await expect(cleanup).rejects.toBe(failure)
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_old')
  })
})

describe('retryFailedStorageCleanup', () => {
  it('clears the local chats and the retry flag without signaling other tabs', async () => {
    await seedLocalChat('stale-local')
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')
    const setItem = vi.spyOn(localStorage, 'setItem')

    await retryFailedStorageCleanup()

    expect(await storedChatIds()).toEqual([])
    expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBeNull()
    expect(setItem).not.toHaveBeenCalledWith(
      AUTH_ACCOUNT_RESET_SIGNAL,
      expect.anything(),
    )
  })

  it('keeps the retry flag when the local chats cannot be cleared', async () => {
    const storage = holdStorageReset()
    const failure = new Error(
      'Timed out resetting IndexedDB for account change',
    )
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')

    const retry = retryFailedStorageCleanup()
    storage.fail(failure)

    await expect(retry).rejects.toBe(failure)
    expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBe('true')
  })
})
