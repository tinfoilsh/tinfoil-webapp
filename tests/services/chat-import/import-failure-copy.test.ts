import { describeImportFailure } from '@/services/chat-import/import-failure-copy'
import { describe, expect, it } from 'vitest'

describe('describeImportFailure', () => {
  it('gives each known reason a distinct explanation', () => {
    const reasons = [
      'timeout',
      'invalid_archive',
      'limit_exceeded',
      'key_mismatch',
      'internal',
    ] as const
    const copy = reasons.map((reason) => describeImportFailure(reason))
    expect(new Set(copy).size).toBe(reasons.length)
  })

  it('uses restore wording for the backup restore surface', () => {
    const restore = describeImportFailure('timeout', 'backup_restore')
    expect(restore).toMatch(/restore/i)
    expect(restore).not.toMatch(/\bimport\b/i)
    expect(restore).not.toBe(describeImportFailure('timeout'))
    expect(describeImportFailure('nope', 'backup_restore')).toBe(
      describeImportFailure('internal', 'backup_restore'),
    )
  })

  it('explains the archive check that failed only when it refines the reason', () => {
    const invalidArchive = describeImportFailure('invalid_archive')
    expect(
      describeImportFailure('invalid_archive', 'chat_import', 'corrupt_zip'),
    ).toMatch(/download was interrupted/i)
    expect(
      describeImportFailure(
        'invalid_archive',
        'chat_import',
        'unexpected_json',
      ),
    ).toMatch(/not files like user\.json/i)
    expect(describeImportFailure('timeout', 'chat_import', 'corrupt_zip')).toBe(
      describeImportFailure('timeout'),
    )
    expect(
      describeImportFailure('invalid_archive', 'backup_restore', 'corrupt_zip'),
    ).toBe(describeImportFailure('invalid_archive', 'backup_restore'))
    expect(
      describeImportFailure('invalid_archive', 'chat_import', 'future_check'),
    ).toBe(invalidArchive)
    expect(
      describeImportFailure('invalid_archive', 'chat_import', 'toString'),
    ).toBe(invalidArchive)
  })

  it('falls back to the generic explanation for unknown or missing reasons', () => {
    const generic = describeImportFailure('internal')
    expect(describeImportFailure('something_new')).toBe(generic)
    expect(describeImportFailure(undefined)).toBe(generic)
    expect(describeImportFailure('toString')).toBe(generic)
  })
})
