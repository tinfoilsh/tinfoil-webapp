import {
  invalidateProfileSyncGeneration,
  runSerializedProfileSync,
} from '@/services/cloud/profile-sync-coordinator'
import { describe, expect, it } from 'vitest'

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
})
