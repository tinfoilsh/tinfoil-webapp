import { describe, expect, it, vi } from 'vitest'
import { createMockControlplane } from '../../scripts/mock-controlplane.mjs'

describe('mock controlplane router', () => {
  it('uses the first registered mock that handles a request', async () => {
    const first = { route: vi.fn(() => null) }
    const response = Promise.resolve()
    const second = { route: vi.fn(() => response) }
    const third = { route: vi.fn(() => Promise.resolve()) }
    const req = {}
    const res = {}
    const router = createMockControlplane({ mocks: [first, second, third] })

    expect(router.route(req, res)).toBe(response)
    expect(first.route).toHaveBeenCalledWith(req, res)
    expect(second.route).toHaveBeenCalledWith(req, res)
    expect(third.route).not.toHaveBeenCalled()
    await response
  })

  it('returns null when no registered mock handles a request', () => {
    const router = createMockControlplane({
      mocks: [{ route: () => null }, { route: () => null }],
    })

    expect(router.route({}, {})).toBeNull()
  })
})
