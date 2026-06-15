#!/usr/bin/env node
// Fill in missing translation keys for every locale from the English source
// catalogs, using the Tinfoil SDK (never raw fetch to the enclave).
//
// Usage:
//   TINFOIL_API_KEY=sk-... node scripts/i18n-translate.mjs [--locale es] [--dry]
//
// Behavior:
//   - English (src/i18n/locales/en/*.json) is the source of truth.
//   - For each other locale folder, any key present in English but missing in
//     the target is translated and merged in; existing translations are left
//     untouched. This makes adding a new string a one-command operation.
//   - Plural variants are translated 1:1 from the English forms; languages with
//     extra CLDR categories (ar/ru/pl/uk) may still need a manual pass.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TinfoilAI } from 'tinfoil'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales')
const SOURCE_LOCALE = 'en'
const MODEL = process.env.TINFOIL_TRANSLATE_MODEL || 'gpt-oss-120b'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const onlyLocale = (() => {
  const i = args.indexOf('--locale')
  return i !== -1 ? args[i + 1] : null
})()

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

function setDeep(obj, dottedKey, value) {
  const parts = dottedKey.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] ??= {}
    node = node[parts[i]]
  }
  node[parts[parts.length - 1]] = value
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

const namespaces = readdirSync(join(LOCALES_DIR, SOURCE_LOCALE))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))

const targets = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== SOURCE_LOCALE)
  .map((d) => d.name)
  .filter((code) => !onlyLocale || code === onlyLocale)

if (!process.env.TINFOIL_API_KEY && !dryRun) {
  console.error('Set TINFOIL_API_KEY (or pass --dry to preview missing keys).')
  process.exit(1)
}

const client = dryRun
  ? null
  : new TinfoilAI({ apiKey: process.env.TINFOIL_API_KEY })
if (client && typeof client.ready === 'function') {
  await client.ready()
}

async function translateBatch(targetName, entries) {
  const prompt =
    `Translate the following UI strings into ${targetName}.\n` +
    `Return ONLY a JSON object mapping each key to its translation.\n` +
    `Preserve interpolation placeholders such as {{name}} and {{count}} exactly.\n` +
    `Keep product names like "Tinfoil" untranslated. Do not add keys.\n\n` +
    JSON.stringify(entries, null, 2)

  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You are a professional software localizer. Output strict JSON only.',
      },
      { role: 'user', content: prompt },
    ],
  })

  const text = res.choices?.[0]?.message?.content ?? '{}'
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1))
}

let totalMissing = 0

for (const locale of targets) {
  const targetName = displayNames.of(locale) || locale
  for (const ns of namespaces) {
    const sourcePath = join(LOCALES_DIR, SOURCE_LOCALE, `${ns}.json`)
    const targetPath = join(LOCALES_DIR, locale, `${ns}.json`)

    const sourceFlat = flatten(readJson(sourcePath))
    const targetJson = readJson(targetPath)
    const targetFlat = flatten(targetJson)

    const missing = {}
    for (const [key, value] of Object.entries(sourceFlat)) {
      if (!(key in targetFlat)) missing[key] = value
    }
    const missingCount = Object.keys(missing).length
    if (missingCount === 0) continue
    totalMissing += missingCount

    console.log(`[${locale}/${ns}] ${missingCount} missing key(s)`)
    if (dryRun) continue

    const translations = await translateBatch(targetName, missing)
    for (const key of Object.keys(missing)) {
      if (translations[key]) setDeep(targetJson, key, translations[key])
    }
    writeFileSync(targetPath, JSON.stringify(targetJson, null, 2) + '\n', 'utf8')
    console.log(`[${locale}/${ns}] updated`)
  }
}

console.log(
  dryRun
    ? `\nDry run complete: ${totalMissing} key(s) would be translated.`
    : `\nDone: ${totalMissing} key(s) translated.`,
)
