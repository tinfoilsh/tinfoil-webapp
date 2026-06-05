import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_CODES,
  NAMESPACES,
  getDirection,
  normalizeLocale,
} from '@/i18n/config'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const LOCALES_DIR = path.resolve(process.cwd(), 'src/i18n/locales')
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, key, out)
    } else {
      out[key] = String(v)
    }
  }
  return out
}

function loadLocale(locale: string): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const ns of NAMESPACES) {
    const raw = readFileSync(
      path.join(LOCALES_DIR, locale, `${ns}.json`),
      'utf8',
    )
    const json = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(flatten(json))) merged[`${ns}:${k}`] = v
  }
  return merged
}

function logicalKeys(flat: Record<string, string>): Set<string> {
  return new Set(Object.keys(flat).map((k) => k.replace(PLURAL_SUFFIX, '')))
}

function placeholdersByLogicalKey(
  flat: Record<string, string>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const [key, value] of Object.entries(flat)) {
    const logical = key.replace(PLURAL_SUFFIX, '')
    const set = map.get(logical) ?? new Set<string>()
    for (const match of value.matchAll(PLACEHOLDER)) set.add(match[1])
    map.set(logical, set)
  }
  return map
}

const en = loadLocale(DEFAULT_LOCALE)
const enLogical = logicalKeys(en)
const enPlaceholders = placeholdersByLogicalKey(en)
const localeFolders = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

describe('i18n config', () => {
  it('ships exactly 25 locales with unique codes', () => {
    expect(LOCALES).toHaveLength(25)
    expect(new Set(LOCALE_CODES).size).toBe(LOCALE_CODES.length)
  })

  it('config codes and locale folders are in sync', () => {
    expect([...LOCALE_CODES].sort()).toEqual([...localeFolders].sort())
  })

  it('normalizeLocale maps region/script variants onto shipped codes', () => {
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('fr-CA')).toBe('fr')
    expect(normalizeLocale('zh')).toBe('zh-Hans')
    expect(normalizeLocale('zh-CN')).toBe('zh-Hans')
    expect(normalizeLocale('zh-TW')).toBe('zh-Hant')
    expect(normalizeLocale('zh-HK')).toBe('zh-Hant')
    expect(normalizeLocale('pt')).toBe('pt-BR')
    expect(normalizeLocale('pt-PT')).toBe('pt-BR')
    expect(normalizeLocale('tl')).toBe('fil')
    expect(normalizeLocale('AR')).toBe('ar')
    expect(normalizeLocale('xx-unknown')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE)
  })

  it('getDirection returns rtl only for RTL locales', () => {
    expect(getDirection('ar')).toBe('rtl')
    expect(getDirection('ur')).toBe('rtl')
    expect(getDirection('fa')).toBe('rtl')
    expect(getDirection('en')).toBe('ltr')
    expect(getDirection('zh-Hans')).toBe('ltr')
    expect(getDirection('he')).toBe('ltr') // not shipped -> falls back to default
  })
})

describe('i18n catalogs', () => {
  for (const locale of LOCALE_CODES) {
    if (locale === DEFAULT_LOCALE) continue

    it(`[${locale}] has the same logical keys as English`, () => {
      const flat = loadLocale(locale)
      const localeLogical = logicalKeys(flat)
      const missing = [...enLogical].filter((k) => !localeLogical.has(k))
      const extra = [...localeLogical].filter((k) => !enLogical.has(k))
      expect(missing, `missing keys in ${locale}`).toEqual([])
      expect(extra, `extra keys in ${locale}`).toEqual([])
    })

    it(`[${locale}] preserves interpolation placeholders`, () => {
      const localePlaceholders = placeholdersByLogicalKey(loadLocale(locale))
      for (const [key, expected] of enPlaceholders) {
        if (expected.size === 0) continue
        const actual = localePlaceholders.get(key) ?? new Set<string>()
        const missing = [...expected].filter((p) => !actual.has(p))
        expect(missing, `${locale} ${key} dropped placeholders`).toEqual([])
      }
    })
  }
})
