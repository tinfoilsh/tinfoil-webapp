import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { pathToRegexp }: { pathToRegexp: (path: string) => RegExp } =
  createRequire(import.meta.url)('next/dist/compiled/path-to-regexp')

// Each dynamic section (/chat, /project, /share) falls back to its own
// exported shell; WEBCAT accepts every shell listed in fallback_hashes. Files,
// Next assets and the WEBCAT well-known directory must 404 for real instead.
// Vercel evaluates `source` with path-to-regexp 6.x (@vercel/routing-utils
// pins 6.1.0); Next bundles the same major, so this parses the pattern the
// way the platform does. Custom regex groups were removed in v7+, so a major
// mismatch would throw here rather than pass silently.
const rewrites = JSON.parse(readFileSync('vercel.json', 'utf8'))
  .rewrites as Array<{ source: string; destination: string }>
const destination = (path: string) =>
  rewrites.find((r) => pathToRegexp(r.source).test(path))?.destination
const shell = (section: string) => `/${section}/%5B%5B...slug%5D%5D.html`

describe('section rewrites', () => {
  it.each([
    ['/chat', shell('chat')],
    ['/chat/', shell('chat')],
    [
      '/chat/local/8209128554471_acac21c0-5c9d-4124-aa81-4574352d749e',
      shell('chat'),
    ],
    ['/project/p1/chat/c1', shell('project')],
    ['/share', shell('share')],
    ['/share/abc', shell('share')],
    ['/newchat', '/newchat.html'],
  ])('sends %s to %s', (path, expected) => {
    expect(destination(path)).toBe(expected)
  })

  it.each([
    '/no-such-page',
    '/chat/missing.js',
    '/share/abc/x.png',
    '/_next/static/chunks/missing.js',
    '/_next/missing',
    '/.well-known/webcat/manifest.json',
    '/.well-known/webcat/missing',
    '/js/boot.js',
    '/favicon.ico',
    '/preview/mermaid.html',
  ])('leaves %s to the filesystem', (path) => {
    expect(destination(path)).toBeUndefined()
  })
})
