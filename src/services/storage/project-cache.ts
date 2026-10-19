import type { Project } from '@/types/project'
import { indexedDBStorage } from './indexed-db'

export const PROJECT_CACHE_UPDATED_EVENT = 'projectCacheUpdated'
let cacheGeneration = 0
let refreshGeneration = 0

function notifyProjectCacheUpdated(userId?: string): void {
  window.dispatchEvent(
    new CustomEvent(PROJECT_CACHE_UPDATED_EVENT, { detail: { userId } }),
  )
}

export const projectCache = {
  captureGeneration(): number {
    return cacheGeneration
  },

  commitMutation(expectedGeneration: number): number | null {
    if (expectedGeneration !== cacheGeneration) return null
    refreshGeneration += 1
    return cacheGeneration
  },

  captureRefreshGeneration(): number {
    return refreshGeneration
  },

  isCurrentRefreshGeneration(generation: number): boolean {
    return generation === refreshGeneration
  },

  invalidate(): void {
    cacheGeneration += 1
    refreshGeneration += 1
  },

  getProjects(userId: string): Promise<Project[]> {
    return indexedDBStorage.getProjectsForUser(userId)
  },

  async replaceProjects(
    userId: string,
    projects: Project[],
    expectedGeneration = cacheGeneration,
  ): Promise<void> {
    if (expectedGeneration !== cacheGeneration) return
    await indexedDBStorage.replaceProjectsForUser(userId, projects)
    if (expectedGeneration !== cacheGeneration) return
    notifyProjectCacheUpdated(userId)
  },

  async saveProject(
    userId: string,
    project: Project,
    expectedGeneration = cacheGeneration,
  ): Promise<void> {
    if (expectedGeneration !== cacheGeneration) return
    await indexedDBStorage.saveProjectForUser(userId, project)
    if (expectedGeneration !== cacheGeneration) return
    notifyProjectCacheUpdated(userId)
  },

  async deleteProject(
    userId: string,
    projectId: string,
    expectedGeneration = cacheGeneration,
  ): Promise<void> {
    if (expectedGeneration !== cacheGeneration) return
    await indexedDBStorage.deleteProjectForUser(userId, projectId)
    if (expectedGeneration !== cacheGeneration) return
    notifyProjectCacheUpdated(userId)
  },

  async clear(): Promise<void> {
    cacheGeneration += 1
    refreshGeneration += 1
    await indexedDBStorage.deleteAllProjects()
    notifyProjectCacheUpdated()
  },
}
