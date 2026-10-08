import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { pathToRegexp }: { pathToRegexp: (path: string) => RegExp } =
  createRequire(import.meta.url)('next/dist/compiled/path-to-regexp')

// Every page URL falls back to the single exported shell; files, Next assets
// and the WEBCAT well-known directory must 404 for real instead.
// Vercel evaluates `source` with path-to-regexp 6.x (@vercel/routing-utils
// pins 6.1.0); Next bundles the same major, so this parses the pattern the
// way the platform does. Custom regex groups like the one below were removed
// in v7+, so a major mismatch would throw here rather than pass silently.
// Cross-checked against the deployed rewrite on 2026-10-01.
const shell = (
  JSON.parse(readFileSync('vercel.json', 'utf8')).rewrites as Array<{
    source: string
    destination: string
  }>
).find((r) => r.destination === '/%5B...slug%5D.html')!
const matches = (path: string) => pathToRegexp(shell.source).test(path)

describe('catch-all rewrite', () => {
  it.each([
    '/chat',
    '/chat/local/8209128554471_acac21c0-5c9d-4124-aa81-4574352d749e',
    '/project/p1/chat/c1',
    '/share/abc',
    '/no-such-page',
  ])('sends page URL %s to the shell', (path) => {
    expect(matches(path)).toBe(true)
  })

  it.each([
    '/_next/static/chunks/missing.js',
    '/_next/missing',
    '/.well-known/webcat/manifest.json',
    '/.well-known/webcat/missing',
    '/js/boot.js',
    '/favicon.ico',
    '/preview/mermaid.html',
  ])('leaves %s to the filesystem', (path) => {
    expect(matches(path)).toBe(false)
  })
})
