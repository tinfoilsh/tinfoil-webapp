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
): AccountOperationGuard & { readonly signal: AbortSignal; dispose(): void } {
  const readUserId = () =>
    typeof window === 'undefined'
      ? null
      : localStorage.getItem(AUTH_ACTIVE_USER_ID)
  const userId = readUserId()
  const controller = new AbortController()
  const invalidate = () => {
    controller.abort(
      new DOMException(
        'Account changed; retry in the current account.',
        'AbortError',
      ),
    )
  }
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
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
    !controller.signal.aborted &&
    readUserId() === userId &&
    (userId === null || !hasRecentExplicitSignoutIntent())
  return {
    userId,
    signal: controller.signal,
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) invalidate()
      controller.signal.throwIfAborted()
    },
    dispose() {
      signal?.removeEventListener('abort', abortFromCaller)
      if (typeof window === 'undefined') return
      window.removeEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, invalidate)
      window.removeEventListener(AUTH_SIGNOUT_REQUESTED_EVENT, invalidate)
      window.removeEventListener('storage', onStorage)
    },
  }
}
