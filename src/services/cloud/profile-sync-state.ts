import {
  SYNC_PROFILE_BASELINE,
  SYNC_PROFILE_LOCAL_METADATA,
} from '@/constants/storage-keys'
import type { ProfileData } from './profile-sync'
import { ProfileDataSchema } from './schemas'

interface StoredProfileState {
  userId: string
  profile: ProfileData
}

function loadState(key: string, userId: string): ProfileData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredProfileState>
    if (parsed.userId !== userId) return null
    const validated = ProfileDataSchema.safeParse(parsed.profile)
    return validated.success ? (validated.data as ProfileData) : null
  } catch {
    return null
  }
}

function saveState(key: string, userId: string, profile: ProfileData): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify({ userId, profile }))
}

export function loadProfileBaseline(userId: string): ProfileData | null {
  return loadState(SYNC_PROFILE_BASELINE, userId)
}

export function saveProfileBaseline(
  userId: string,
  profile: ProfileData,
): void {
  saveState(SYNC_PROFILE_BASELINE, userId, profile)
}

export function loadLocalProfileMetadata(userId: string): ProfileData | null {
  return loadState(SYNC_PROFILE_LOCAL_METADATA, userId)
}

export function saveLocalProfileMetadata(
  userId: string,
  profile: ProfileData,
): void {
  saveState(SYNC_PROFILE_LOCAL_METADATA, userId, profile)
}

export function clearProfileSyncState(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(SYNC_PROFILE_BASELINE)
  localStorage.removeItem(SYNC_PROFILE_LOCAL_METADATA)
}
