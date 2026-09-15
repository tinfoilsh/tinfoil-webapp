import {
  normalizeResponseLanguage,
  resolveResponseLanguage,
  RESPONSE_LANGUAGES,
  SYSTEM_RESPONSE_LANGUAGE,
} from '@/utils/response-language'
import { describe, expect, it } from 'vitest'

describe('response language', () => {
  it('defaults missing and empty values to System', () => {
    expect(normalizeResponseLanguage(null)).toBe(SYSTEM_RESPONSE_LANGUAGE)
    expect(normalizeResponseLanguage('')).toBe(SYSTEM_RESPONSE_LANGUAGE)
  })

  it('resolves System from the preferred browser locale', () => {
    expect(resolveResponseLanguage('System', ['fr-CA', 'en-US'])).toBe(
      'Canadian French',
    )
    expect(resolveResponseLanguage('System', ['ja-JP'])).not.toBe('System')
  })

  it('preserves known and unknown explicit values', () => {
    expect(resolveResponseLanguage('Spanish', ['fr-CA'])).toBe('Spanish')
    expect(resolveResponseLanguage('Klingon', ['fr-CA'])).toBe('Klingon')
    expect(normalizeResponseLanguage('  Klingon  ')).toBe('  Klingon  ')
  })

  it('matches the current iOS language choices', () => {
    expect(RESPONSE_LANGUAGES).toContain('System')
    expect(RESPONSE_LANGUAGES).toContain('Afrikaans')
    expect(RESPONSE_LANGUAGES).toContain('Yiddish')
    expect(RESPONSE_LANGUAGES).toHaveLength(71)
  })
})
