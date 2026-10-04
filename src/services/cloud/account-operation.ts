import {
  AUTH_ACTIVE_USER_CHANGED_EVENT,
  AUTH_SIGNOUT_REQUESTED_EVENT,
} from '@/constants/auth-events'
import {
  AUTH_ACCOUNT_RESET_SIGNAL,
  AUTH_ACTIVE_USER_ID,
} from '@/constants/storage-keys'
import { hasRecentExplicitSignoutIntent } from '@/utils/auth-signout-intent'

export interface AccountOperationGuard {
  readonly userId: string | null
  assertCurrent(): void
  isCurrent(): boolean
}

/** A lightweight read guard with no dependency on the cloud-sync coordinator. */
export function createActiveAccountGuard(
  signal?: AbortSignal,
): AccountOperationGuard & { dispose(): void } {
  const readUserId = () =>
    typeof window === 'undefined'
      ? null
      : localStorage.getItem(AUTH_ACTIVE_USER_ID)
  const userId = readUserId()
  let invalidated = false
  const invalidate = () => {
    invalidated = true
  }
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === AUTH_ACTIVE_USER_ID ||
      event.key === AUTH_ACCOUNT_RESET_SIGNAL
    )
      invalidate()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, invalidate)
    window.addEventListener(AUTH_SIGNOUT_REQUESTED_EVENT, invalidate)
    window.addEventListener('storage', onStorage)
  }
  const isCurrent = () =>
    !invalidated &&
    !signal?.aborted &&
    readUserId() === userId &&
    (userId === null || !hasRecentExplicitSignoutIntent())
  return {
    userId,
    isCurrent,
    assertCurrent() {
      signal?.throwIfAborted()
      if (!isCurrent())
        throw new DOMException(
          'Account changed; retry in the current account.',
          'AbortError',
        )
    },
    dispose() {
      if (typeof window === 'undefined') return
      window.removeEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, invalidate)
      window.removeEventListener(AUTH_SIGNOUT_REQUESTED_EVENT, invalidate)
      window.removeEventListener('storage', onStorage)
    },
  }
}
