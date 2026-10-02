import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// scripts/patch-clerk-worker.mjs (postinstall) rewrites the pinned clerk-js
// bundle to load its timer worker from this origin instead of a blob URL,
// which worker-src 'self' forbids, and extracts the worker source verbatim.
describe('Clerk timer worker', () => {
  it('is loaded from this origin, not a blob URL', () => {
    const bundle = readFileSync(
      'node_modules/@clerk/clerk-js/dist/clerk.no-rhc.mjs',
      'utf8',
    )
    expect(bundle).toContain('new Worker("/workers/clerk-timers.js"')
    expect(bundle).not.toMatch(/createObjectURL\(\w+\);return new Worker/)
  })

  it('has its source extracted next to the other static assets', () => {
    const worker = readFileSync('public/workers/clerk-timers.js', 'utf8')
    expect(worker).toContain('workerToTabIds')
    expect(worker).toContain('self.addEventListener("message"')
  })
})
