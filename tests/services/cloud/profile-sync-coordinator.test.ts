import {
  invalidateProfileSyncGeneration,
  runSerializedProfileSync,
} from '@/services/cloud/profile-sync-coordinator'
import { describe, expect, it, vi } from 'vitest'

describe('profile sync coordinator', () => {
  it('serializes complete profile sync operations', async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = runSerializedProfileSync('user-1', async () => {
      order.push('first-start')
      await firstBlocked
      order.push('first-end')
    })
    const second = runSerializedProfileSync('user-1', async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('invalidates queued work from a previous account generation', async () => {
    let ran = false
    const queued = runSerializedProfileSync('user-1', async () => {
      ran = true
    })
    invalidateProfileSyncGeneration()

    await queued
    expect(ran).toBe(false)
  })

  it('does not block a new account behind the previous account', async () => {
    let releaseOldAccount: (() => void) | undefined
    const oldAccountBlocked = new Promise<void>((resolve) => {
      releaseOldAccount = resolve
    })
    const oldAccount = runSerializedProfileSync('user-1', async () => {
      await oldAccountBlocked
    })
    await Promise.resolve()

    invalidateProfileSyncGeneration()
    let newAccountRan = false
    await runSerializedProfileSync('user-2', async () => {
      newAccountRan = true
    })

    expect(newAccountRan).toBe(true)
    releaseOldAccount?.()
    await oldAccount
  })

  it('keeps local invalidation when broadcast storage is unavailable', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage unavailable')
      })

    expect(() => invalidateProfileSyncGeneration(true)).not.toThrow()
    setItem.mockRestore()
  })
})
