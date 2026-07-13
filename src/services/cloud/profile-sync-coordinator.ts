import { SYNC_PROFILE_GENERATION } from '@/constants/storage-keys'

let generation = 0
let queue: Promise<void> = Promise.resolve()
let isListeningForInvalidation = false

function listenForCrossTabInvalidation(): void {
  if (isListeningForInvalidation || typeof window === 'undefined') {
    return
  }
  isListeningForInvalidation = true
  window.addEventListener('storage', (event) => {
    if (event.key === SYNC_PROFILE_GENERATION || event.key === null) {
      generation += 1
    }
  })
}

export function invalidateProfileSyncGeneration(broadcast = false): void {
  generation += 1
  if (broadcast && typeof window !== 'undefined') {
    localStorage.setItem(SYNC_PROFILE_GENERATION, crypto.randomUUID())
  }
}

export function runSerializedProfileSync(
  userId: string,
  operation: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  listenForCrossTabInvalidation()
  const operationGeneration = generation
  const isCurrent = () => operationGeneration === generation

  const run = async () => {
    if (!isCurrent()) return
    const execute = () => operation(isCurrent)
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(`tinfoil-profile-sync:${userId}`, execute)
    } else {
      await execute()
    }
  }

  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
