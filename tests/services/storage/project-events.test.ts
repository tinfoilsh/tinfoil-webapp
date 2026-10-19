import { SYNC_PROJECTS_INVALIDATED } from '@/constants/storage-keys'
import {
  invalidateProjects,
  projectEvents,
} from '@/services/project/project-events'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('project invalidation', () => {
  afterEach(() => {
    projectEvents.clear()
    vi.restoreAllMocks()
  })

  it('notifies the current tab and writes a cross-tab signal', () => {
    const firstSignal = '00000000-0000-4000-8000-000000000001'
    const secondSignal = '00000000-0000-4000-8000-000000000002'
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(firstSignal)
      .mockReturnValueOnce(secondSignal)
    const handler = vi.fn()
    projectEvents.on('projects-invalidated', handler)

    invalidateProjects()

    expect(handler).toHaveBeenCalledWith({ type: 'projects-invalidated' })
    expect(localStorage.getItem(SYNC_PROJECTS_INVALIDATED)).toBe(firstSignal)
    invalidateProjects()
    expect(localStorage.getItem(SYNC_PROJECTS_INVALIDATED)).toBe(secondSignal)
    expect(handler.mock.calls).toEqual([
      [{ type: 'projects-invalidated' }],
      [{ type: 'projects-invalidated' }],
    ])
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Unavailable', 'QuotaExceededError')
    })
    invalidateProjects()
    expect(handler).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenLastCalledWith({ type: 'projects-invalidated' })
  })
})
