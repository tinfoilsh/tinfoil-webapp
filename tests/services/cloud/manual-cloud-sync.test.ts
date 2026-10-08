import { runManualCloudSync } from '@/services/cloud/manual-cloud-sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const successfulChatSync = { uploaded: 1, downloaded: 1, errors: [] }

describe('runManualCloudSync', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('awaits chat and profile sync before reloading chats', async () => {
    const order: string[] = []
    let finishChats!: () => void
    let finishProfile!: () => void
    const chats = new Promise<void>((resolve) => {
      finishChats = resolve
    })
    const profile = new Promise<void>((resolve) => {
      finishProfile = resolve
    })
    const syncChats = vi.fn(async () => {
      await chats
      order.push('chats')
      return successfulChatSync
    })
    const syncProfile = vi.fn(async () => {
      await profile
      order.push('profile')
      return true
    })
    const reloadChats = vi.fn(async () => {
      order.push('reload')
    })

    const sync = runManualCloudSync({ syncChats, syncProfile, reloadChats })
    await vi.advanceTimersByTimeAsync(0)
    expect(reloadChats).not.toHaveBeenCalled()
    finishChats()
    await vi.advanceTimersByTimeAsync(0)
    expect(reloadChats).not.toHaveBeenCalled()
    finishProfile()
    await expect(sync).resolves.toBe(true)
    expect(syncChats).toHaveBeenCalledOnce()
    expect(syncProfile).toHaveBeenCalledOnce()
    expect(reloadChats).toHaveBeenCalledOnce()
    expect(order.at(-1)).toBe('reload')
  })

  it('reports chat sync failures after syncing the profile', async () => {
    const syncProfile = vi.fn().mockResolvedValue(true)

    await expect(
      runManualCloudSync({
        syncChats: vi.fn().mockResolvedValue(false),
        syncProfile,
        reloadChats: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(false)
    expect(syncProfile).toHaveBeenCalledOnce()
  })

  it('waits for profile sync when chat sync rejects', async () => {
    let finishProfile: ((value: boolean) => void) | undefined
    const syncPromise = runManualCloudSync({
      syncChats: vi.fn().mockRejectedValue(new Error('chat sync failed')),
      syncProfile: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishProfile = resolve
          }),
      ),
      reloadChats: vi.fn().mockResolvedValue(undefined),
    })
    let settled = false
    void syncPromise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    finishProfile?.(true)
    await expect(syncPromise).rejects.toThrow('chat sync failed')
  })

  it('reports profile sync failures', async () => {
    await expect(
      runManualCloudSync({
        syncChats: vi.fn().mockResolvedValue(successfulChatSync),
        syncProfile: vi.fn().mockResolvedValue(false),
        reloadChats: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(false)
  })

  it('prioritizes sync failures over reload failures', async () => {
    await expect(
      runManualCloudSync({
        syncChats: vi.fn().mockRejectedValue(new Error('chat sync failed')),
        syncProfile: vi.fn().mockResolvedValue(true),
        reloadChats: vi.fn().mockRejectedValue(new Error('reload failed')),
      }),
    ).rejects.toThrow('chat sync failed')
  })

  it('reports a resolved sync failure before a reload rejection', async () => {
    await expect(
      runManualCloudSync({
        syncChats: vi.fn().mockResolvedValue(false),
        syncProfile: vi.fn().mockResolvedValue(true),
        reloadChats: vi.fn().mockRejectedValue(new Error('reload failed')),
      }),
    ).resolves.toBe(false)
  })
})
