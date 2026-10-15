import { resetRendererRegistry } from '@/components/chat/renderers'
import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACTIVE_USER_ID,
  SETTINGS_HAS_SEEN_ONBOARDING,
  USER_ENCRYPTION_KEY,
  USER_PREFS_PINNED_CHAT_IDS,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import { encryptionService } from '@/services/encryption/encryption-service'
import { getView, harnessAPI, publish } from '@/services/harness/runtime'
import {
  performSignoutCleanup,
  performUserSwitchCleanup,
  retryFailedStorageCleanup,
} from '@/utils/signout-cleanup'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/renderers', () => ({
  resetRendererRegistry: vi.fn(),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const LEGACY_DATABASE = 'tinfoil-chat'
const ACCOUNT_KEY = `key_${'ar'.repeat(32)}`

async function seedLegacyDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chats').put({ title: 'Private' }, 'c1')
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

async function databaseNames(): Promise<(string | undefined)[]> {
  return (await indexedDB.databases()).map((database) => database.name)
}

function holdDatabaseDeletion() {
  const request: {
    error: DOMException | null
    onsuccess?: () => void
    onerror?: () => void
    onblocked?: () => void
  } = { error: null }
  const deleteDatabase = vi.fn(() => request)
  vi.stubGlobal('indexedDB', { deleteDatabase })
  return { deleteDatabase, request }
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

  it('clears the key, harness, caches, and local database of the signed-out account', async () => {
    const api = harnessAPI()
    publish({ profile: { nickname: 'Private' } })
    await encryptionService.setKey(ACCOUNT_KEY)
    await seedLegacyDatabase()
    expect(await databaseNames()).toEqual([LEGACY_DATABASE])

    await performSignoutCleanup()

    expect(api.lifetime.signal.aborted).toBe(true)
    expect(getView().profile).toEqual({})
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    expect(() => encryptionService.getKeyBytesOrThrow()).toThrow()
    expect(resetRendererRegistry).toHaveBeenCalledOnce()
    expect(await databaseNames()).toEqual([])
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
    const deletion = holdDatabaseDeletion()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const cleanup = performSignoutCleanup()
    try {
      expect(deletion.deleteDatabase).toHaveBeenCalledExactlyOnceWith(
        LEGACY_DATABASE,
      )
      await Promise.resolve()
      expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
    } finally {
      deletion.request.onsuccess?.()
      await cleanup
    }

    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBeNull()
  })

  it('keeps the active-user marker when browser data cannot be cleared', async () => {
    const deletion = holdDatabaseDeletion()
    const failure = new DOMException('denied', 'UnknownError')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    await withPinnedChatChanges(
      async () => {
        const cleanup = performSignoutCleanup()
        deletion.request.error = failure
        deletion.request.onerror?.()
        await expect(cleanup).rejects.toBe(failure)
      },
      (handle) => expect(handle).toHaveBeenCalledTimes(1),
    )

    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
  })

  it('refuses to finish while another tab holds the local database open', async () => {
    await seedLegacyDatabase()
    const open = indexedDB.open(LEGACY_DATABASE, 1)
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    try {
      await expect(performSignoutCleanup()).rejects.toThrow(
        'Close other Tinfoil tabs before clearing this device.',
      )
      expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
    } finally {
      connection.close()
    }
  })
})

describe('performUserSwitchCleanup', () => {
  it('aborts the old harness and removes account data', async () => {
    const api = harnessAPI()
    publish({ profile: { nickname: 'Private' } })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
    localStorage.setItem(USER_ENCRYPTION_KEY, 'key_private')
    sessionStorage.setItem('harness-run:alice', 'routing')

    await performUserSwitchCleanup('bob')

    expect(api.lifetime.signal.aborted).toBe(true)
    expect(getView().profile).toEqual({})
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('bob')
    expect(sessionStorage.length).toBe(0)
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
    const deletion = holdDatabaseDeletion()
    const failure = new DOMException('denied', 'UnknownError')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_old')

    const cleanup = performUserSwitchCleanup('user_new')
    deletion.request.error = failure
    deletion.request.onerror?.()

    await expect(cleanup).rejects.toBe(failure)
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_old')
  })
})

describe('retryFailedStorageCleanup', () => {
  it('deletes the local database and clears the retry flag', async () => {
    await seedLegacyDatabase()
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')

    await retryFailedStorageCleanup()

    expect(await databaseNames()).toEqual([])
    expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBeNull()
  })

  it('keeps the retry flag when the database cannot be deleted', async () => {
    const deletion = holdDatabaseDeletion()
    const failure = new DOMException('denied', 'UnknownError')
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')

    const retry = retryFailedStorageCleanup()
    deletion.request.error = failure
    deletion.request.onerror?.()

    await expect(retry).rejects.toBe(failure)
    expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBe('true')
  })
})
