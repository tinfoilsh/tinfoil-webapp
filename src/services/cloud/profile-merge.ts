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
  'isUsingCustomPrompt',
  'customSystemPrompt',
  'customPromptPresets',
  'favoritePromptPresetIds',
  'selectedModel',
  'reasoningEffort',
  'thinkingEnabled',
  'webSearchEnabled',
  'codeExecutionEnabled',
  'piiCheckEnabled',
  'genUIEnabled',
  'chatFont',
  'projectUploadPreference',
] as const

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
    const differ =
      typeof a === 'object' || typeof b === 'object'
        ? JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
        : a !== b
    if (differ) changed.push(field)
  }
  return changed
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
    nonEmptyString(p.customSystemPrompt) ||
    nonEmptyArray(p.traits) ||
    nonEmptyArray(p.customPromptPresets) ||
    nonEmptyArray(p.favoritePromptPresetIds)
  )
}

function laterTimestamp(a?: string, b?: string): string | undefined {
  const ta = a ? new Date(a).getTime() : NaN
  const tb = b ? new Date(b).getTime() : NaN
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return ta >= tb ? a : b
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
  const mergedClocks: Record<string, EditClock> = {
    ...(local.fieldClocks ?? {}),
  }
  let adoptedRemote = false

  for (const field of PROFILE_MERGE_FIELDS) {
    const remoteHasField = Object.prototype.hasOwnProperty.call(remote, field)
    const lc = fieldClock(local, field, localTrusted)
    const rc = fieldClock(remote, field, remoteTrusted)
    if (!remoteHasField) {
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
