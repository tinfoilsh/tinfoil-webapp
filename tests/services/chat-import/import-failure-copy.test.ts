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
    const copy = reasons.map(describeImportFailure)
    expect(new Set(copy).size).toBe(reasons.length)
    expect(describeImportFailure('timeout')).toMatch(/run the import again/i)
    expect(describeImportFailure('key_mismatch')).toMatch(
      /nothing was written/i,
    )
  })

  it('falls back to the generic explanation for unknown or missing reasons', () => {
    const generic = describeImportFailure('internal')
    expect(describeImportFailure('something_new')).toBe(generic)
    expect(describeImportFailure(undefined)).toBe(generic)
    expect(describeImportFailure('toString')).toBe(generic)
  })
})
