import {
  PROJECT_CACHE_UPDATED_EVENT,
  projectCache,
} from '@/services/storage/project-cache'
import type { Project } from '@/types/project'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveProjectForUser: vi.fn(),
  deleteAllProjects: vi.fn(),
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getProjectsForUser: vi.fn(),
    replaceProjectsForUser: vi.fn(),
    saveProjectForUser: mocks.saveProjectForUser,
    deleteProjectForUser: vi.fn(),
    deleteAllProjects: mocks.deleteAllProjects,
  },
}))

const project: Project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
  syncVersion: 1,
}

describe('projectCache', () => {
  beforeEach(() => {
    mocks.saveProjectForUser.mockReset().mockResolvedValue(undefined)
    mocks.deleteAllProjects.mockReset().mockResolvedValue(undefined)
  })

  it('rejects writes from invalidated account operations', async () => {
    const generation = projectCache.captureGeneration()
    projectCache.invalidate()

    await projectCache.saveProject('user-1', project, generation)

    expect(mocks.saveProjectForUser).not.toHaveBeenCalled()
  })

  it('clears durable project data after invalidating pending writes', async () => {
    const generation = projectCache.captureGeneration()
    let finishDeletion!: () => void
    mocks.deleteAllProjects.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDeletion = resolve
      }),
    )
    const notified = vi.fn()
    window.addEventListener(PROJECT_CACHE_UPDATED_EVENT, notified)
    const clearing = projectCache.clear()
    try {
      await projectCache.saveProject('user-1', project, generation)
      expect(mocks.deleteAllProjects).toHaveBeenCalledOnce()
      expect(mocks.saveProjectForUser).not.toHaveBeenCalled()
      expect(notified).not.toHaveBeenCalled()
      finishDeletion()
      await clearing
      expect(notified).toHaveBeenCalledOnce()
    } finally {
      finishDeletion()
      await clearing
      window.removeEventListener(PROJECT_CACHE_UPDATED_EVENT, notified)
    }
  })

  it('keeps concurrent point mutations in the same account session', async () => {
    const sessionGeneration = projectCache.captureGeneration()
    const refreshGeneration = projectCache.captureRefreshGeneration()
    const firstGeneration = projectCache.commitMutation(sessionGeneration)
    const secondGeneration = projectCache.commitMutation(sessionGeneration)

    expect(firstGeneration).not.toBeNull()
    expect(secondGeneration).not.toBeNull()
    expect(projectCache.isCurrentRefreshGeneration(refreshGeneration)).toBe(
      false,
    )

    const notified = vi.fn<(event: Event) => void>()
    window.addEventListener(PROJECT_CACHE_UPDATED_EVENT, notified)
    try {
      await Promise.all([
        projectCache.saveProject('user-1', project, firstGeneration!),
        projectCache.saveProject(
          'user-1',
          { ...project, id: 'project-2' },
          secondGeneration!,
        ),
      ])
      expect(mocks.saveProjectForUser.mock.calls).toEqual([
        ['user-1', project],
        ['user-1', { ...project, id: 'project-2' }],
      ])
      expect(
        notified.mock.calls.map(([event]) => (event as CustomEvent).detail),
      ).toEqual([{ userId: 'user-1' }, { userId: 'user-1' }])
    } finally {
      window.removeEventListener(PROJECT_CACHE_UPDATED_EVENT, notified)
    }
  })
})
