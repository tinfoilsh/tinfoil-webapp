import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// scripts/patch-clerk-worker.mjs (postinstall) rewrites the pinned clerk-js
// bundle to load its timer worker from this origin instead of a blob URL,
// which worker-src 'self' forbids, and extracts the worker source verbatim.
describe('Clerk timer worker', () => {
  afterEach(() => vi.useRealTimers())
  it('is loaded from this origin, not a blob URL', () => {
    const bundle = readFileSync(
      'node_modules/@clerk/clerk-js/dist/clerk.no-rhc.mjs',
      'utf8',
    )
    expect(bundle).toContain('new Worker("/workers/clerk-timers.js"')
    expect(bundle).not.toMatch(/createObjectURL\(\w+\);return new Worker/)
  })

  it('has its source extracted next to the other static assets', () => {
    vi.useFakeTimers()
    const worker = readFileSync('public/workers/clerk-timers.js', 'utf8')
    expect(worker).toContain('workerToTabIds')
    expect(worker).toContain('self.addEventListener("message"')
    const postMessage = vi.fn()
    let handle!: (event: {
      data: { type: string; id: string; ms?: number }
    }) => void
    const addEventListener = vi.fn((type, listener) => {
      expect(type).toBe('message')
      handle = listener
    })
    runInNewContext(worker, {
      self: { postMessage, addEventListener },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    })
    expect(addEventListener).toHaveBeenCalledOnce()
    handle({ data: { type: 'setTimeout', id: 'once', ms: 10 } })
    handle({ data: { type: 'setTimeout', id: 'canceled', ms: 10 } })
    handle({ data: { type: 'clearTimeout', id: 'canceled' } })
    vi.advanceTimersByTime(9)
    expect(postMessage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(postMessage.mock.calls).toEqual([[{ id: 'once' }]])
    handle({ data: { type: 'setInterval', id: 'repeat', ms: 10 } })
    vi.advanceTimersByTime(20)
    expect(postMessage.mock.calls).toEqual([
      [{ id: 'once' }],
      [{ id: 'repeat' }],
      [{ id: 'repeat' }],
    ])
    handle({ data: { type: 'clearInterval', id: 'repeat' } })
    vi.advanceTimersByTime(20)
    expect(postMessage).toHaveBeenCalledTimes(3)
  })
})
