import {
  describeOffDeviceImportKickoff,
  getDeleteAllChatsSuccessDescription,
  getDeleteAllChatsSuccessTitle,
  importResultTitle,
} from '@/components/chat/settings-modal'
import { describe, expect, it } from 'vitest'

describe('settings chat deletion confirmation', () => {
  it('scopes the title to the device when cloud deletion is incomplete', () => {
    expect(getDeleteAllChatsSuccessTitle(true, false)).toBe(
      'Chats deleted from this device',
    )
    expect(getDeleteAllChatsSuccessTitle(true, true)).toBe('All chats deleted')
    expect(getDeleteAllChatsSuccessTitle(false, false)).toBe(
      'All chats deleted',
    )
  })

  it('describes completed cloud deletion without claiming an email was sent', () => {
    expect(getDeleteAllChatsSuccessDescription(true, true)).toBe(
      'Removed all chats from this device and encrypted cloud storage.',
    )
  })

  it('warns signed-in users when cloud deletion did not complete', () => {
    expect(getDeleteAllChatsSuccessDescription(true, false)).toBe(
      'Removed all chats from this device. Encrypted cloud storage was not cleared.',
    )
  })

  it('keeps guest deletion scoped to the browser session', () => {
    expect(getDeleteAllChatsSuccessDescription(false, false)).toBe(
      'Removed all chats from this browser session.',
    )
  })
})

describe('off-device import kickoff', () => {
  it('announces a running job and promises an email', () => {
    const result = describeOffDeviceImportKickoff(
      { status: 'running', imported: 0, failed: 0, total: 0 },
      'Claude',
    )
    expect(result).toMatchObject({
      success: true,
      pending: true,
      failed: false,
    })
    expect(result.message).toMatch(/Claude export is being imported/)
    expect(result.message).toMatch(/email you/)
  })

  it('reports a job that already failed instead of announcing a start', () => {
    const result = describeOffDeviceImportKickoff(
      {
        status: 'failed',
        imported: 0,
        failed: 0,
        total: 0,
        errors: ['import key is not the current key'],
        failure_reason: 'key_mismatch',
      },
      'Claude',
    )
    expect(result).toMatchObject({
      success: false,
      pending: false,
      failed: true,
      errors: ['import key is not the current key'],
    })
    expect(result.message).toMatch(/encryption key/i)
    expect(result.message).not.toMatch(/being imported/)
  })

  it('treats a job that completed synchronously as done', () => {
    const result = describeOffDeviceImportKickoff(
      { status: 'completed', imported: 2, failed: 0, total: 2 },
      'ChatGPT',
    )
    expect(result).toMatchObject({
      success: true,
      pending: false,
      failed: false,
      chatsImported: 2,
    })
    expect(result.message).toBeUndefined()
  })

  it('titles the result by its outcome', () => {
    const base = { chatsImported: 0, projectsImported: 0, errors: [] }
    expect(importResultTitle({ ...base, success: true, pending: true })).toBe(
      'Import in progress',
    )
    expect(importResultTitle({ ...base, success: true })).toBe(
      'Import complete',
    )
    expect(importResultTitle({ ...base, success: false, failed: true })).toBe(
      'Import failed',
    )
    expect(importResultTitle({ ...base, success: false })).toBe(
      'Import completed with errors',
    )
  })
})
