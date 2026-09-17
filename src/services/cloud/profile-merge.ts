import {
  MAX_PINNED_CHATS,
  normalizePinnedChatIds,
} from '../storage/pinned-chats'
import type { EditClock } from './edit-clock'
import type { ProfileData } from './profile-sync'
import { remoteWins } from './sync-predicates'

/**
 * User-facing profile fields that participate in the field-level
 * conflict merge. Metadata (version, updatedAt, clocks) is handled
 * separately and intentionally excluded.
 */
export const PROFILE_MERGE_FIELDS = [
  'isDarkMode',
  'themeMode',
  'language',
  'nickname',
  'profession',
  'traits',
  'additionalContext',
  'isUsingPersonalization',
  'customPromptPresets',
  'favoritePromptPresetIds',
  'defaultPromptPresetId',
  'pinnedChatIds',
  'reasoningEffort',
  'thinkingEnabled',
  'webSearchEnabled',
  'webSearchAvailable',
  'codeExecutionEnabled',
  'pixelateSidebarChatTitlesEnabled',
  'browserTabChatTitleEnabled',
  'piiCheckEnabled',
  'enterToNewlineEnabled',
  'genUIEnabled',
  'chatFont',
] as const

// Older clients omit this field, while the setting itself has no unset state.
const PRESERVE_LOCAL_WHEN_REMOTE_OMITS = new Set<
  (typeof PROFILE_MERGE_FIELDS)[number]
>([
  'pixelateSidebarChatTitlesEnabled',
  'browserTabChatTitleEnabled',
  'pinnedChatIds',
  'enterToNewlineEnabled',
  'defaultPromptPresetId',
])

const TREAT_LOCAL_OMISSION_AS_UNEDITED = new Set<
  (typeof PROFILE_MERGE_FIELDS)[number]
>(['language', 'isUsingPersonalization'])

// A blob's field clocks are trustworthy only when they were maintained
// at the row's current server version. If a clock-unaware client wrote
// since, clockVersion lags the etag and we must not trust the clocks.
function clocksTrusted(p: ProfileData | null | undefined): boolean {
  return !!p && p.clockVersion != null && p.clockVersion === p.version
}

function fieldClock(
  p: ProfileData | null | undefined,
  field: string,
  trusted: boolean,
): EditClock | undefined {
  if (!trusted || !p?.fieldClocks) return undefined
  const c = p.fieldClocks[field]
  return c && typeof c.v === 'number' && typeof c.w === 'string' ? c : undefined
}

/**
 * Field names whose local value differs from the last-synced baseline.
 * Derived by diffing values rather than tracking UI events, so a field
 * can never be missed because its change event was not wired up.
 */
export function changedProfileFields(
  local: ProfileData,
  baseline: ProfileData | null | undefined,
): string[] {
  if (!baseline) return [...PROFILE_MERGE_FIELDS]
  const changed: string[] = []
  for (const field of PROFILE_MERGE_FIELDS) {
    const a = (local as Record<string, unknown>)[field]
    const b = (baseline as Record<string, unknown>)[field]
    if (!valuesEqual(a, b)) changed.push(field)
  }
  return changed
}

export function overlayProfileChanges(
  remote: ProfileData,
  before: ProfileData,
  after: ProfileData,
): { profile: ProfileData; changedFields: string[] } {
  const profile = { ...remote }
  const changedFields = changedProfileFields(after, before)
  for (const field of changedFields) {
    if (Object.prototype.hasOwnProperty.call(after, field)) {
      ;(profile as Record<string, unknown>)[field] = (
        after as Record<string, unknown>
      )[field]
    } else {
      delete (profile as Record<string, unknown>)[field]
    }
  }
  return { profile, changedFields }
}

export function reconcileDirtyProfileWithoutBaseline(args: {
  remote: ProfileData
  localBeforeFetch: ProfileData
  localAfterFetch: ProfileData
}): ProfileData | null {
  const { remote, localBeforeFetch, localAfterFetch } = args
  const localHasMigrationSafeField = [...PRESERVE_LOCAL_WHEN_REMOTE_OMITS].some(
    (field) => Object.prototype.hasOwnProperty.call(localBeforeFetch, field),
  )

  if (!localHasMigrationSafeField) return null

  const profile = { ...remote }
  for (const field of PROFILE_MERGE_FIELDS) {
    const localHasField = Object.prototype.hasOwnProperty.call(
      localBeforeFetch,
      field,
    )
    if (!localHasField) continue

    const remoteHasField = Object.prototype.hasOwnProperty.call(remote, field)
    const localValue = (localBeforeFetch as Record<string, unknown>)[field]
    if (field === 'pinnedChatIds' && remoteHasField) {
      continue
    }
    if (
      remoteHasField &&
      !valuesEqual(localValue, (remote as Record<string, unknown>)[field])
    ) {
      return null
    }
    if (!remoteHasField) {
      if (!PRESERVE_LOCAL_WHEN_REMOTE_OMITS.has(field)) return null
      ;(profile as Record<string, unknown>)[field] = localValue
    }
  }

  // Only migration-safe fields may be missing remotely. Any other
  // difference remains blocked until a baseline exists.
  const reconciled = overlayProfileChanges(
    profile,
    localBeforeFetch,
    localAfterFetch,
  ).profile
  if (
    localBeforeFetch.pinnedChatIds !== undefined ||
    localAfterFetch.pinnedChatIds !== undefined
  ) {
    const localBeforePins = localBeforeFetch.pinnedChatIds ?? []
    const localAfterPins = localAfterFetch.pinnedChatIds ?? localBeforePins
    if (
      localBeforeFetch.pinnedChatIds !== undefined &&
      localAfterFetch.pinnedChatIds !== undefined &&
      localBeforePins.length === 0 &&
      localAfterPins.length === 0
    ) {
      reconciled.pinnedChatIds = []
      return reconciled
    }
    const removedDuringFetch = new Set(
      localBeforePins.filter((chatId) => !localAfterPins.includes(chatId)),
    )
    const candidates = [
      ...localAfterPins,
      ...(remote.pinnedChatIds ?? []).filter(
        (chatId) => !removedDuringFetch.has(chatId),
      ),
    ]
    const uniqueCandidateCount = new Set(
      candidates.map((chatId) => chatId.trim()).filter(Boolean),
    ).size
    if (uniqueCandidateCount > MAX_PINNED_CHATS) return null
    reconciled.pinnedChatIds = normalizePinnedChatIds(candidates)
  }
  return reconciled
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

/**
 * True when the profile carries user content worth protecting (a name,
 * prompts, traits, etc.). Used to refuse letting an empty/default blob
 * silently wipe a populated profile on the fallback arbitration path.
 */
export function isProfilePopulated(p: ProfileData | null | undefined): boolean {
  if (!p) return false
  return (
    nonEmptyString(p.nickname) ||
    nonEmptyString(p.profession) ||
    nonEmptyString(p.additionalContext) ||
    nonEmptyString(p.defaultPromptPresetId) ||
    nonEmptyArray(p.traits) ||
    nonEmptyArray(p.customPromptPresets) ||
    nonEmptyArray(p.favoritePromptPresetIds) ||
    nonEmptyArray(p.pinnedChatIds)
  )
}

function laterTimestamp(a?: string, b?: string): string | undefined {
  const ta = a ? new Date(a).getTime() : NaN
  const tb = b ? new Date(b).getTime() : NaN
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return ta >= tb ? a : b
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  }
  return a === b
}

function laterClock(
  localClock: EditClock | undefined,
  remoteClock: EditClock | undefined,
): EditClock | undefined {
  if (!localClock) return remoteClock
  if (!remoteClock) return localClock
  return remoteWins({ localClock, remoteClock }) ? remoteClock : localClock
}

export interface ThreeWayProfileMergeResult {
  merged: ProfileData
  conflicts: string[]
  adoptedRemote: boolean
}

export function mergeProfilesThreeWay(args: {
  baseline: ProfileData
  local: ProfileData
  remote: ProfileData
}): ThreeWayProfileMergeResult {
  const { baseline, local, remote } = args
  const localTrusted = clocksTrusted(local)
  const remoteTrusted = clocksTrusted(remote)
  const merged: ProfileData = { ...local }
  const mergedClocks: Record<string, EditClock> = {}
  const conflicts: string[] = []
  let adoptedRemote = false

  for (const field of PROFILE_MERGE_FIELDS) {
    const baselineValue = (baseline as Record<string, unknown>)[field]
    const localHasField = Object.prototype.hasOwnProperty.call(local, field)
    const localValue =
      !localHasField && TREAT_LOCAL_OMISSION_AS_UNEDITED.has(field)
        ? baselineValue
        : (local as Record<string, unknown>)[field]
    const remoteValue = (remote as Record<string, unknown>)[field]
    const lc = fieldClock(local, field, localTrusted)
    const rc = fieldClock(remote, field, remoteTrusted)

    if (
      !Object.prototype.hasOwnProperty.call(remote, field) &&
      PRESERVE_LOCAL_WHEN_REMOTE_OMITS.has(field)
    ) {
      if (lc) mergedClocks[field] = lc
      continue
    }

    if (valuesEqual(localValue, baselineValue)) {
      if (Object.prototype.hasOwnProperty.call(remote, field)) {
        ;(merged as Record<string, unknown>)[field] = remoteValue
        if (rc) mergedClocks[field] = rc
        adoptedRemote ||= !valuesEqual(localValue, remoteValue)
      } else {
        delete (merged as Record<string, unknown>)[field]
      }
    } else if (valuesEqual(localValue, remoteValue)) {
      const clock = laterClock(lc, rc)
      if (clock) mergedClocks[field] = clock
    } else if (valuesEqual(remoteValue, baselineValue)) {
      if (lc) mergedClocks[field] = lc
    } else if (lc && rc) {
      if (
        remoteWins({
          localClock: lc,
          remoteClock: rc,
        })
      ) {
        ;(merged as Record<string, unknown>)[field] = remoteValue
        mergedClocks[field] = rc
        adoptedRemote = true
      } else {
        mergedClocks[field] = lc
      }
    } else {
      conflicts.push(field)
      if (lc) mergedClocks[field] = lc
    }
  }

  merged.version = remote.version
  merged.clockVersion = remote.version
  merged.fieldClocks =
    Object.keys(mergedClocks).length > 0 ? mergedClocks : undefined
  merged.updatedAt = laterTimestamp(local.updatedAt, remote.updatedAt)

  return { merged, conflicts, adoptedRemote }
}

/**
 * Merge a remote profile into the local one field by field. Each field
 * is arbitrated by its edit clock when both sides are trusted (a
 * convergent CRDT LWW-register, immune to clock skew), falling back to
 * whole-blob updatedAt when a clock is absent or untrusted.
 *
 * Returns the merged profile plus whether any field was adopted from
 * the remote (so the caller knows it must apply the result locally).
 */
export function mergeProfiles(args: {
  local: ProfileData
  remote: ProfileData
}): { merged: ProfileData; adoptedRemote: boolean } {
  const { local, remote } = args
  const localTrusted = clocksTrusted(local)
  const remoteTrusted = clocksTrusted(remote)
  const fallback = !(localTrusted && remoteTrusted)

  // On the fallback path there is no per-field signal to trust, so a
  // single empty/default remote could clobber every populated local
  // field at once (the data-loss incident). Refuse it outright.
  if (fallback && !isProfilePopulated(remote) && isProfilePopulated(local)) {
    return { merged: { ...local }, adoptedRemote: false }
  }

  const merged: ProfileData = { ...local }
  // Build the merged clocks from scratch, carrying only clocks we
  // actually trust. Seeding from local.fieldClocks would smuggle
  // untrusted/stale clocks into the output, which the next push
  // re-stamps as trusted (clockVersion === version) and corrupts future
  // conflict resolution.
  const mergedClocks: Record<string, EditClock> = {}
  let adoptedRemote = false

  for (const field of PROFILE_MERGE_FIELDS) {
    const remoteHasField = Object.prototype.hasOwnProperty.call(remote, field)
    const lc = fieldClock(local, field, localTrusted)
    const rc = fieldClock(remote, field, remoteTrusted)
    if (!remoteHasField) {
      // Remote omits this field: keep the local value and its clock, but
      // only when the local clock is trusted.
      if (lc) mergedClocks[field] = lc
      continue
    }
    const takeRemote = remoteWins({
      localClock: lc,
      remoteClock: rc,
      localUpdatedAt: local.updatedAt,
      remoteUpdatedAt: remote.updatedAt,
    })
    if (takeRemote) {
      ;(merged as Record<string, unknown>)[field] = (
        remote as Record<string, unknown>
      )[field]
      // Record a clock for the adopted value only if the remote clock is
      // trusted; otherwise leave it absent so future reads fall back to
      // updatedAt for this field.
      if (rc) mergedClocks[field] = rc
      adoptedRemote = true
    } else if (lc) {
      mergedClocks[field] = lc
    }
  }

  merged.fieldClocks =
    Object.keys(mergedClocks).length > 0 ? mergedClocks : undefined
  merged.updatedAt =
    laterTimestamp(local.updatedAt, remote.updatedAt) ??
    new Date().toISOString()
  return { merged, adoptedRemote }
}
