import { SYNC_PROJECTS_INVALIDATED } from '@/constants/storage-keys'
import { useProjects } from '@/hooks/use-projects'
import type { Project, ProjectListResponse } from '@/types/project'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: { isSignedIn: true, userId: 'cached-project-user' },
  getCachedProjects: vi.fn(),
  replaceProjects: vi.fn(),
  listProjects: vi.fn(),
  getRemoteProjects: vi.fn(),
  invalidateCache: vi.fn(),
  cacheState: { generation: 0, refreshGeneration: 0 },
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('@/services/storage/project-cache', () => ({
  PROJECT_CACHE_UPDATED_EVENT: 'projectCacheUpdated',
  projectCache: {
    captureGeneration: () => mocks.cacheState.generation,
    captureRefreshGeneration: () => mocks.cacheState.refreshGeneration,
    isCurrentRefreshGeneration: (generation: number) =>
      generation === mocks.cacheState.refreshGeneration,
    invalidate: () => {
      mocks.cacheState.generation += 1
      mocks.cacheState.refreshGeneration += 1
      mocks.invalidateCache()
    },
    getProjects: mocks.getCachedProjects,
    replaceProjects: mocks.replaceProjects,
  },
}))

vi.mock('@/services/cloud/project-storage', () => ({
  projectStorage: {
    listProjects: mocks.listProjects,
    getProjects: mocks.getRemoteProjects,
  },
}))

const cachedProject: Project = {
  id: 'project-1',
  name: 'Cached project',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-08-10T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:00.000Z',
  syncVersion: 1,
}

describe('useProjects', () => {
  beforeEach(() => {
    mocks.auth.isSignedIn = true
    mocks.auth.userId = 'cached-project-user'
    mocks.cacheState.generation = 0
    mocks.cacheState.refreshGeneration = 0
    mocks.invalidateCache.mockReset()
    mocks.getCachedProjects.mockReset().mockResolvedValue([cachedProject])
    mocks.replaceProjects.mockReset().mockResolvedValue(undefined)
    mocks.listProjects.mockReset()
    mocks.getRemoteProjects.mockReset()
  })

  it('renders cached projects while revalidating in the background', async () => {
    let resolveRemotePage!: (value: {
      projects: Array<{
        id: string
        key: string
        createdAt: string
        updatedAt: string
        syncVersion: number
        size: number
      }>
      hasMore: boolean
    }) => void
    mocks.listProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveRemotePage = resolve
      }),
    )

    const { result } = renderHook(() => useProjects())

    await waitFor(() => {
      expect(result.current.projects).toEqual([cachedProject])
      expect(result.current.loading).toBe(false)
    })

    const refreshedProject = { ...cachedProject, name: 'Refreshed project' }
    mocks.getRemoteProjects.mockResolvedValue(
      new Map([[refreshedProject.id, refreshedProject]]),
    )
    await act(async () => {
      resolveRemotePage({
        projects: [
          {
            id: refreshedProject.id,
            key: refreshedProject.id,
            createdAt: refreshedProject.createdAt,
            updatedAt: refreshedProject.updatedAt,
            syncVersion: refreshedProject.syncVersion,
            size: 0,
          },
        ],
        hasMore: false,
      })
    })

    await waitFor(() =>
      expect(result.current.projects[0]?.name).toBe('Refreshed project'),
    )
    expect(mocks.replaceProjects).toHaveBeenCalledWith(
      'cached-project-user',
      [refreshedProject],
      0,
    )
  })

  it('clears cross-tab stale state and ignores an invalidated in-flight refresh', async () => {
    mocks.auth.userId = 'cross-tab-project-user'
    let resolveStalePage!: (value: ProjectListResponse) => void
    mocks.listProjects
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStalePage = resolve
        }),
      )
      .mockResolvedValueOnce({ projects: [], hasMore: false })
    mocks.getRemoteProjects.mockImplementation(async (ids: string[]) =>
      ids.includes(cachedProject.id)
        ? new Map([[cachedProject.id, cachedProject]])
        : new Map(),
    )

    const { result } = renderHook(() => useProjects())
    await waitFor(() =>
      expect(result.current.projects).toEqual([cachedProject]),
    )

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SYNC_PROJECTS_INVALIDATED,
          newValue: 'another-tab-signal',
        }),
      )
    })

    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.projects).toEqual([]))
    expect(mocks.invalidateCache).toHaveBeenCalledOnce()

    await act(async () => {
      resolveStalePage({
        projects: [
          {
            id: cachedProject.id,
            key: cachedProject.id,
            createdAt: cachedProject.createdAt,
            updatedAt: cachedProject.updatedAt,
            syncVersion: cachedProject.syncVersion,
            size: 0,
          },
        ],
        hasMore: false,
      })
    })

    await waitFor(() => expect(result.current.projects).toEqual([]))
    expect(mocks.replaceProjects).toHaveBeenCalledTimes(1)
    expect(mocks.replaceProjects).toHaveBeenCalledWith(
      'cross-tab-project-user',
      [],
      1,
    )
  })

  it('hides the previous account projects immediately on user change', async () => {
    let resolveRemotePage!: (value: {
      projects: ProjectListResponse['projects']
      hasMore: boolean
    }) => void
    mocks.auth.userId = 'first-project-user'
    mocks.listProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveRemotePage = resolve
      }),
    )
    const { result, rerender } = renderHook(() => useProjects())
    await waitFor(() =>
      expect(result.current.projects).toEqual([cachedProject]),
    )

    mocks.auth.userId = 'second-project-user'
    mocks.getCachedProjects.mockReturnValue(new Promise(() => {}))
    mocks.listProjects.mockReturnValue(new Promise(() => {}))
    rerender()

    expect(result.current.projects).toEqual([])
    expect(result.current.loading).toBe(true)
    const previousUserProject = {
      ...cachedProject,
      id: 'previous-user-project',
    }
    mocks.getRemoteProjects.mockResolvedValue(
      new Map([[previousUserProject.id, previousUserProject]]),
    )
    await act(async () => {
      resolveRemotePage({
        projects: [
          {
            id: previousUserProject.id,
            key: previousUserProject.id,
            createdAt: previousUserProject.createdAt,
            updatedAt: previousUserProject.updatedAt,
            syncVersion: previousUserProject.syncVersion,
            size: 0,
          },
        ],
        hasMore: false,
      })
    })
    await waitFor(() => expect(result.current.projects).toEqual([]))
  })

  it('settles loading when cache and remote reads fail', async () => {
    mocks.auth.userId = 'failed-project-user'
    mocks.getCachedProjects.mockRejectedValue(new Error('Cache unavailable'))
    mocks.listProjects.mockRejectedValue(new Error('Remote unavailable'))

    const { result } = renderHook(() => useProjects())

    await waitFor(() => expect(result.current.error).toBe('Remote unavailable'))
    expect(result.current.loading).toBe(false)
    expect(result.current.projects).toEqual([])
  })

  it('does not expose the previous account cache when the next load fails', async () => {
    mocks.auth.userId = 'loaded-project-user'
    mocks.listProjects.mockReturnValue(new Promise(() => {}))
    const { result, rerender } = renderHook(() => useProjects())
    await waitFor(() =>
      expect(result.current.projects).toEqual([cachedProject]),
    )

    mocks.auth.userId = 'failed-next-project-user'
    mocks.getCachedProjects.mockRejectedValue(new Error('Cache unavailable'))
    mocks.listProjects.mockRejectedValue(new Error('Remote unavailable'))
    rerender()

    await waitFor(() => expect(result.current.error).toBe('Remote unavailable'))
    expect(result.current.projects).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})
