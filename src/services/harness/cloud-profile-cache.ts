import {
  AUTH_ACTIVE_USER_ID,
  CLOUD_PROFILE_CACHE_PREFIX,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import type { Profile } from './runtime'

// The cloud profile this device last loaded or saved for an account. Only
// the account active on this device reads or writes its copy.

const cacheKey = (userId: string) =>
  `${CLOUD_PROFILE_CACHE_PREFIX}:${encodeURIComponent(userId)}`

const isActive = (userId: string | null): userId is string =>
  !!userId && localStorage.getItem(AUTH_ACTIVE_USER_ID) === userId

export function readCloudProfileCache(userId: string | null): Profile {
  try {
    if (!isActive(userId)) return {}
    const stored = localStorage.getItem(cacheKey(userId))
    const profile: unknown = stored === null ? null : JSON.parse(stored)
    return profile && typeof profile === 'object' && !Array.isArray(profile)
      ? profile
      : {}
  } catch (error) {
    logError('Failed to read the cached settings', error, {
      component: 'cloudProfileCache',
      action: 'read',
    })
    return {}
  }
}

export function writeCloudProfileCache(
  userId: string | null,
  profile: Profile,
) {
  try {
    if (isActive(userId))
      localStorage.setItem(cacheKey(userId), JSON.stringify(profile))
  } catch (error) {
    logError('Failed to cache the settings', error, {
      component: 'cloudProfileCache',
      action: 'write',
    })
  }
}

export function clearCloudProfileCache(userId: string | null) {
  if (!userId) return
  try {
    localStorage.removeItem(cacheKey(userId))
  } catch (error) {
    logError('Failed to clear the cached settings', error, {
      component: 'cloudProfileCache',
      action: 'clear',
    })
  }
}
