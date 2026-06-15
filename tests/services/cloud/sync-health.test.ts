import {
  getSyncHealthSnapshot,
  reportChatSynced,
  reportChatSyncFailed,
  reportKeyActionRequired,
  reportKeyHealthy,
  reportSyncPaused,
  reportSyncSuccess,
  resetSyncHealth,
  subscribeSyncHealth,
  SYNC_PAUSED_ATTENTION_AFTER_MS,
  syncHealthNeedsAttention,
} from '@/services/cloud/sync-health'
import { beforeEach, describe, expect, it } from 'vitest'

describe('sync-health store', () => {
  beforeEach(() => {
    resetSyncHealth()
  })

  it('starts healthy with no failures', () => {
    const snapshot = getSyncHealthSnapshot()
    expect(snapshot.gate.kind).toBe('ok')
    expect(snapshot.failedChats).toEqual({})
    expect(snapshot.lastSyncedAt).toBeNull()
    expect(syncHealthNeedsAttention(snapshot)).toBe(false)
  })

  it('sets and clears an action-required gate via key health', () => {
    reportKeyActionRequired('key-recovery')
    expect(getSyncHealthSnapshot().gate).toMatchObject({
      kind: 'action-required',
      reason: 'key-recovery',
    })
    expect(syncHealthNeedsAttention(getSyncHealthSnapshot())).toBe(true)

    reportKeyHealthy()
    expect(getSyncHealthSnapshot().gate.kind).toBe('ok')
  })

  it('never downgrades action-required to paused', () => {
    reportKeyActionRequired('key-mismatch')
    reportSyncPaused('attestation')
    expect(getSyncHealthSnapshot().gate).toMatchObject({
      kind: 'action-required',
      reason: 'key-mismatch',
    })
  })

  it('a completed sync pass clears paused but not action-required', () => {
    reportSyncPaused('network')
    reportSyncSuccess()
    expect(getSyncHealthSnapshot().gate.kind).toBe('ok')
    expect(getSyncHealthSnapshot().lastSyncedAt).not.toBeNull()

    reportKeyActionRequired('key-conflict')
    reportSyncSuccess()
    expect(getSyncHealthSnapshot().gate.kind).toBe('action-required')
  })

  it('tracks per-chat failures until the chat syncs', () => {
    reportChatSyncFailed('chat-1', 'nope')
    reportChatSyncFailed('chat-2', 'nope')
    expect(Object.keys(getSyncHealthSnapshot().failedChats)).toHaveLength(2)
    expect(syncHealthNeedsAttention(getSyncHealthSnapshot())).toBe(true)

    reportChatSynced('chat-1')
    expect(getSyncHealthSnapshot().failedChats).toEqual({ 'chat-2': 'nope' })

    reportChatSynced('chat-2')
    expect(syncHealthNeedsAttention(getSyncHealthSnapshot())).toBe(false)
  })

  it('only escalates a paused gate after the attention window', () => {
    reportSyncPaused('attestation')
    const snapshot = getSyncHealthSnapshot()
    if (snapshot.gate.kind !== 'paused') throw new Error('expected paused')
    expect(syncHealthNeedsAttention(snapshot, snapshot.gate.since)).toBe(false)
    expect(
      syncHealthNeedsAttention(
        snapshot,
        snapshot.gate.since + SYNC_PAUSED_ATTENTION_AFTER_MS,
      ),
    ).toBe(true)
  })

  it('notifies subscribers on changes and stops after unsubscribe', () => {
    let calls = 0
    const unsubscribe = subscribeSyncHealth(() => {
      calls++
    })
    reportKeyActionRequired('key-recovery')
    expect(calls).toBe(1)

    // Same-state reports are deduplicated.
    reportKeyActionRequired('key-recovery')
    expect(calls).toBe(1)

    unsubscribe()
    reportKeyHealthy()
    expect(calls).toBe(1)
  })
})
