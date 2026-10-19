import {
  describeImportProgress,
  describeOffDeviceImportError,
  describeOffDeviceImportKickoff,
  describeOffDeviceImportOutcome,
  getDeleteAllChatsSuccessDescription,
  getDeleteAllChatsSuccessTitle,
  importResultTitle,
} from '@/components/chat/settings-modal'
import { ImportSequenceError } from '@/services/harness/archives'
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

  it.each([
    {
      signedIn: true,
      cloudDeleted: true,
      description:
        'Removed all chats from this device and encrypted cloud storage.',
    },
    {
      signedIn: true,
      cloudDeleted: false,
      description:
        'Removed all chats from this device. Encrypted cloud storage was not cleared.',
    },
    {
      signedIn: false,
      cloudDeleted: false,
      description: 'Removed all chats from this browser session.',
    },
  ])(
    'describes deletion scope (signed in: $signedIn, cloud deleted: $cloudDeleted)',
    ({ signedIn, cloudDeleted, description }) => {
      expect(getDeleteAllChatsSuccessDescription(signedIn, cloudDeleted)).toBe(
        description,
      )
    },
  )
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

describe('import outcome across split files', () => {
  const files = [
    'conversations-000.json',
    'conversations-001.json',
    'conversations-002.json',
  ]

  it('counts chats from finished files while the last one runs', () => {
    const result = describeOffDeviceImportOutcome(
      {
        status: { status: 'running', imported: 2, failed: 0, total: 9 },
        fileIndex: 2,
        importedBefore: 7,
        interrupted: false,
      },
      files,
      'ChatGPT',
    )
    expect(result).toMatchObject({
      success: true,
      pending: true,
      failed: false,
      chatsImported: 9,
    })
    expect(result.message).toMatch(/email you/)
  })

  it('names the failed file, explains the check, and counts files never started', () => {
    const result = describeOffDeviceImportOutcome(
      {
        status: {
          status: 'failed',
          imported: 0,
          failed: 0,
          total: 0,
          errors: ['import archive could not be read'],
          failureReason: 'invalid_archive',
          failureDetail: 'unexpected_json',
        },
        fileIndex: 0,
        importedBefore: 0,
        interrupted: false,
      },
      files,
      'ChatGPT',
    )
    expect(result).toEqual({
      success: false,
      failed: true,
      pending: false,
      chatsImported: 0,
      projectsImported: 0,
      errors: [
        'conversations-000.json: This file is from the export but does not contain conversations. Select the conversations JSON files, such as conversations.json or conversations-000.json, not files like user.json.',
        '2 remaining files were not imported.',
      ],
    })
  })

  it('reports a lost job as a failure on its file, keeping earlier chats', () => {
    const result = describeOffDeviceImportOutcome(
      {
        status: { status: 'running', imported: 3, failed: 0, total: 8 },
        fileIndex: 1,
        importedBefore: 4,
        interrupted: true,
      },
      files,
      'ChatGPT',
    )
    expect(result).toMatchObject({
      success: false,
      failed: true,
      pending: false,
      chatsImported: 7,
    })
    expect(result.errors).toEqual([
      'conversations-001.json: The import stopped before it finished. Chats already imported were kept; select this file again to continue.',
      '1 remaining file was not imported.',
    ])
  })

  it('keeps earlier chats and names the file when a later file throws', () => {
    const result = describeOffDeviceImportError(
      new ImportSequenceError(
        new Error('an import is already in progress'),
        1,
        4,
      ),
      files,
    )
    expect(result).toEqual({
      success: false,
      chatsImported: 4,
      projectsImported: 0,
      errors: [
        'conversations-001.json: an import is already in progress',
        '1 remaining file was not imported.',
      ],
    })
  })

  it('reports a single file that throws by its message alone', () => {
    expect(
      describeOffDeviceImportError(
        new ImportSequenceError(new Error('The export file is empty'), 0, 0),
        ['export.zip'],
      ),
    ).toEqual({
      success: false,
      chatsImported: 0,
      projectsImported: 0,
      errors: ['The export file is empty'],
    })
  })
})

describe('import progress', () => {
  it('advances an upload a file at a time', () => {
    expect(
      describeImportProgress({
        type: 'upload',
        file: 2,
        files: 3,
        uploadedBytes: 2 * 1024 * 1024,
        totalBytes: 8 * 1024 * 1024,
      }),
    ).toEqual({
      title: 'Uploading file 2 of 3...',
      detail: '2.0 MB of 8.0 MB uploaded',
      percent: 25,
    })
    expect(
      describeImportProgress({
        type: 'upload',
        file: 1,
        files: 1,
        uploadedBytes: 0,
        totalBytes: 3 * 1024,
      }),
    ).toEqual({
      title: 'Uploading export...',
      detail: '3.0 KB',
      percent: 0,
    })
  })

  it('counts the chats of a file being processed', () => {
    expect(
      describeImportProgress({
        type: 'processing',
        file: 1,
        files: 2,
        imported: 3,
        total: 12,
      }),
    ).toEqual({
      title: 'Importing file 1 of 2...',
      detail:
        '3 of 12 chats. Keep this page open until every file has started.',
      percent: 25,
    })
  })
})
