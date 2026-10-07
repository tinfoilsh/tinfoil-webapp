import { SettingsModal } from '@/components/chat/settings-modal'
import type { Chat } from '@/components/chat/types'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import * as archive from '@/services/chat-export/export-archive'
import {
  cloudSync,
  type PaginatedChatsResult,
} from '@/services/cloud/cloud-sync'
import { chatStorage } from '@/services/storage/chat-storage'
import {
  indexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { sessionChatStorage } from '@/services/storage/session-storage'
import * as syncApi from '@/services/sync-enclave/sync-api'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ userId: 'export-owner-a', signedIn: true }))
const toast = vi.hoisted(() => vi.fn())
vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    getToken: async () => null,
    signOut: vi.fn(),
    isSignedIn: auth.signedIn,
  }),
  useUser: () => ({ user: auth.signedIn ? { id: auth.userId } : null }),
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('@/services/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/passkey')>()),
  loadPasskeyCredentials: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/services/cloud/cloud-key-preflight', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/cloud/cloud-key-preflight')
  >()),
  validateCurrentPrimaryKey: vi
    .fn()
    .mockResolvedValue({ canWrite: true, remoteState: 'exists' }),
}))

const OWNER_A = 'export-owner-a'
const OWNER_B = 'export-owner-b'
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const DOWNLOAD_URL = 'blob:export-ownership-test'
const chat: Chat = {
  id: 'private-a',
  title: 'Owner A title',
  createdAt: new Date(CREATED_AT),
  updatedAt: CREATED_AT,
  messages: [
    {
      role: 'user',
      content: 'Owner A message',
      timestamp: new Date(CREATED_AT),
    },
  ],
}
const storedChat: StoredChat = {
  ...chat,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastAccessedAt: 0,
  syncUserId: OWNER_A,
}
const page: PaginatedChatsResult = { chats: [storedChat], hasMore: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function Harness() {
  return (
    <SettingsModal
      isOpen
      setIsOpen={vi.fn()}
      isDarkMode
      themeMode="dark"
      setThemeMode={vi.fn()}
      isClient={false}
      onOpenPromptLibrary={vi.fn()}
      encryptionKey={null}
      initialTab="data"
      isSignedIn={auth.signedIn}
    />
  )
}

describe('settings chat export ownership', () => {
  let blobs: Blob[]
  beforeEach(() => {
    auth.userId = OWNER_A
    auth.signedIn = true
    toast.mockClear()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, OWNER_A)
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    vi.spyOn(chatStorage, 'getAllChats').mockResolvedValue([])
    vi.spyOn(indexedDBStorage, 'clearRevisionSyncState').mockResolvedValue(
      undefined,
    )
    vi.spyOn(cloudSync, 'loadChatsWithPagination').mockResolvedValue(page)
    vi.spyOn(syncApi, 'attachmentGet').mockResolvedValue(
      new Uint8Array([1, 2, 3]),
    )
    blobs = []
    vi.spyOn(window.URL, 'createObjectURL').mockImplementation((value) => {
      if (!(value instanceof Blob)) throw new Error('Expected an archive Blob')
      blobs.push(value)
      return DOWNLOAD_URL
    })
    vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('exports all pages with real serialization while the owner remains current', async () => {
    vi.mocked(cloudSync.loadChatsWithPagination)
      .mockResolvedValueOnce({ ...page, hasMore: true, nextToken: 'page-two' })
      .mockResolvedValueOnce({
        chats: [
          { ...storedChat, id: 'second-a', title: 'Second conversation' },
        ],
        hasMore: false,
      })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Export Chats' }))
    await waitFor(() =>
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce(),
    )
    expect(blobs).toHaveLength(1)
    expect(JSON.parse(await blobs[0].text())).toMatchObject([
      {
        uuid: 'private-a',
        name: 'Owner A title',
        chat_messages: [{ text: 'Owner A message' }],
      },
      { uuid: 'second-a', name: 'Second conversation' },
    ])
    expect(window.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      DOWNLOAD_URL,
    )
    expect(cloudSync.loadChatsWithPagination).toHaveBeenCalledTimes(2)
  })

  it('passes the same captured guard to every export page', async () => {
    const captureGuard = vi.spyOn(cloudSync, 'createAccountOperationGuard')
    vi.mocked(cloudSync.loadChatsWithPagination)
      .mockResolvedValueOnce({ ...page, hasMore: true, nextToken: 'page-two' })
      .mockResolvedValueOnce(page)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Export Chats' }))
    await waitFor(() =>
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce(),
    )
    expect(captureGuard).toHaveBeenCalledOnce()
    const guard = captureGuard.mock.results[0].value
    expect(guard.userId).toBe(OWNER_A)
    expect(
      vi
        .mocked(cloudSync.loadChatsWithPagination)
        .mock.calls.map((call) => call[1]),
    ).toEqual([guard, guard])
  })

  it('revokes the archive URL without clicking when ownership expires at download', async () => {
    vi.mocked(window.URL.createObjectURL).mockImplementationOnce(() => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, OWNER_B)
      cloudSync.resetForAccountChange()
      return DOWNLOAD_URL
    })
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Export Chats' })
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(button).toBeEnabled())
    expect(window.URL.createObjectURL).toHaveBeenCalledOnce()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(window.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      DOWNLOAD_URL,
    )
    expect(
      document.querySelector('a[download="conversations.json"]'),
    ).toBeNull()
  })

  it('preserves anonymous local and session export without contacting cloud', async () => {
    auth.signedIn = false
    localStorage.removeItem(AUTH_ACTIVE_USER_ID)
    vi.mocked(chatStorage.getAllChats).mockResolvedValue([chat])
    vi.spyOn(sessionChatStorage, 'getAllChats').mockReturnValue([
      { ...chat, id: 'session-chat' },
    ])
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Export Chats' }))
    await waitFor(() =>
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce(),
    )
    expect(
      JSON.parse(await blobs[0].text()).map(
        (value: { uuid: string }) => value.uuid,
      ),
    ).toEqual(['private-a', 'session-chat'])
    expect(cloudSync.loadChatsWithPagination).not.toHaveBeenCalled()
  })

  it.each(['local', 'page', 'attachment', 'serialization'])(
    'does not download across an owner switch during %s',
    async (stage) => {
      const entered = deferred<void>()
      const release = deferred<void>()
      if (stage === 'local') {
        vi.mocked(chatStorage.getAllChats).mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          return [chat]
        })
      } else if (stage === 'page') {
        vi.mocked(cloudSync.loadChatsWithPagination).mockImplementationOnce(
          async () => {
            entered.resolve()
            await release.promise
            return { ...page, hasMore: true, nextToken: 'old-owner-page-two' }
          },
        )
      } else if (stage === 'attachment') {
        vi.mocked(chatStorage.getAllChats).mockResolvedValue([
          {
            ...chat,
            messages: [
              {
                ...chat.messages[0],
                attachments: [
                  {
                    id: 'attachment-a',
                    type: 'image',
                    fileName: 'a.png',
                    encryptionKey: 'key-a',
                  },
                  {
                    id: 'attachment-b',
                    type: 'image',
                    fileName: 'b.png',
                    encryptionKey: 'key-b',
                  },
                ],
              },
            ],
          },
        ])
        vi.mocked(syncApi.attachmentGet).mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          return new Uint8Array([1, 2, 3])
        })
      } else {
        const realBuild = archive.buildChatExport
        vi.spyOn(archive, 'buildChatExport').mockImplementationOnce(
          async (...args) => {
            const built = await realBuild(...args)
            entered.resolve()
            await release.promise
            return built
          },
        )
      }
      const view = render(<Harness />)
      const button = screen.getByRole('button', { name: 'Export Chats' })
      await act(async () => {
        fireEvent.click(button)
        await entered.promise
      })
      await act(async () => {
        auth.userId = OWNER_B
        localStorage.setItem(AUTH_ACTIVE_USER_ID, OWNER_B)
        cloudSync.resetForAccountChange()
        view.rerender(<Harness />)
        release.resolve()
      })
      await waitFor(() => expect(button).toBeEnabled())
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
      expect(window.URL.createObjectURL).not.toHaveBeenCalled()
      if (stage === 'local')
        expect(cloudSync.loadChatsWithPagination).not.toHaveBeenCalled()
      if (stage === 'page')
        expect(cloudSync.loadChatsWithPagination).toHaveBeenCalledOnce()
      if (stage === 'attachment')
        expect(syncApi.attachmentGet).toHaveBeenCalledOnce()
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Export complete' }),
      )
    },
  )
})
