import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Clerk creates its timer worker from a blob URL, which worker-src 'self'
// forbids. patches/@clerk+clerk-js+*.patch points it at
// public/workers/clerk-timers.js instead; this keeps that file identical to
// the worker source embedded in the pinned bundle.
const bundle = readFileSync(
  'node_modules/@clerk/clerk-js/dist/clerk.no-rhc.mjs',
  'utf8',
)
const strip = (s: string) => s.replace(/^\/\/.*$/gm, '').replace(/\s+/g, '')

describe('Clerk timer worker', () => {
  it('is loaded from this origin, not a blob URL', () => {
    expect(bundle).toContain('new Worker("/workers/clerk-timers.js"')
    expect(bundle).not.toMatch(
      /createObjectURL\([a-z]\),?\s*[a-z]?\)?;?\s*return new Worker/,
    )
  })

  it('matches the worker source embedded in the bundle', () => {
    const embedded = bundle.match(/\brl='((?:[^'\\]|\\.)*)'/)![1]
    const decoded = JSON.parse(`"${embedded.replace(/"/g, '\\"')}"`)
    expect(strip(readFileSync('public/workers/clerk-timers.js', 'utf8'))).toBe(
      strip(decoded),
    )
  })
})
