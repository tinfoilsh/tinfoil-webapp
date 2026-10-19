import type { AccountOperationGuard } from '@/services/cloud/account-operation'
import { projectCache } from '@/services/storage/project-cache'
import { invalidateProjects } from './project-events'

export async function clearDeletedProjectsForAccount(
  guard: AccountOperationGuard,
  onCacheError: (error: unknown) => void,
): Promise<void> {
  guard.assertCurrent()
  try {
    await projectCache.clear()
  } catch (error) {
    onCacheError(error)
  }
  guard.assertCurrent()
  invalidateProjects()
}
