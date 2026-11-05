import { reportProfileError, useHarness } from '@/services/harness/provider'
import type { PresetUpdate, PromptEdits } from '@/services/harness/types'
import {
  TfLightbulb,
  TfLightning,
  TfMask,
  TfTranslation,
  TfWriting2,
  type IconType,
} from '@tinfoilsh/tinfoil-icons'
import {
  TfCode2Animated,
  TfScholarAnimated,
  TfWritingAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import { useMemo } from 'react'
import type {
  PromptPreset,
  PromptPresetSettings,
  UserPromptPreset,
} from '../prompts/types'
const presetIcons: Record<string, IconType> = {
  student: TfScholarAnimated,
  code: TfCode2Animated,
  'pencil-line': TfWriting2,
  lightbulb: TfLightbulb,
  translate: TfTranslation,
  lightning: TfLightning,
  'mask-happy': TfMask,
}
export const MAX_FAVORITE_PRESETS = 3

// What a change to a saved prompt sets: the text it names, and each setting
// it names, which one named as undefined clears.
export type PresetChanges = Partial<
  Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>
> &
  PromptPresetSettings

// Applies the settings a change names. A setting set to undefined is
// removed rather than stored as undefined; one the change leaves out stays.
function withSettings<T extends object>(
  preset: T,
  settings: PromptPresetSettings,
): T & PromptPresetSettings {
  const next: T & PromptPresetSettings = { ...preset }
  for (const key of ['model', 'webSearchEnabled'] as const) {
    if (!(key in settings)) continue
    if (settings[key] === undefined) delete next[key]
    else Object.assign(next, { [key]: settings[key] })
  }
  return next
}

export function usePromptLibrary() {
  const { session, profile, api } = useHarness()
  const saved: UserPromptPreset[] | undefined = profile.customPromptPresets
  const offered = session?.presets
  const raw: UserPromptPreset[] = saved ?? []
  // The same presets while the saved and offered ones do not change, so
  // what shows the chosen one does not render again.
  const { userPresets, builtInPresets, allPresets } = useMemo(() => {
    const userPresets: PromptPreset[] = (saved ?? []).map((p) => ({
      ...p,
      Icon: TfWritingAnimated,
      isBuiltIn: false,
    }))
    const builtInPresets: PromptPreset[] = (offered ?? []).map((p) => ({
      ...p,
      description: p.description ?? '',
      Icon: presetIcons[p.icon ?? ''] ?? TfWritingAnimated,
      isBuiltIn: true,
      systemPrompt: p.systemPrompt ?? '',
    }))
    return {
      userPresets,
      builtInPresets,
      allPresets: [...builtInPresets, ...userPresets],
    }
  }, [saved, offered])
  const getPresetById = (id: string | null | undefined) =>
    allPresets.find((p) => p.id === id) ?? null
  const favoritePresetIds: string[] = profile.favoritePromptPresetIds ?? []
  const favoritePresets = favoritePresetIds.flatMap((id) =>
    allPresets.filter((p) => p.id === id),
  )
  // The harness keeps the preset new chats start with, and stamps it on a
  // stored chat's first turn.
  const defaultPresetId =
    typeof profile.defaultPromptPresetId === 'string' &&
    profile.defaultPromptPresetId
      ? profile.defaultPromptPresetId
      : null
  const edit = (edits: PromptEdits) => {
    void api.editPrompts(edits).catch(reportProfileError)
  }
  const createUserPreset = (
    input: Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'> &
      PromptPresetSettings,
  ) => {
    const p = withSettings(
      {
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        id: `user:${crypto.randomUUID()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      input,
    )
    edit({ savePromptPresets: [p] })
    return { ...p, Icon: TfWritingAnimated, isBuiltIn: false }
  }
  return {
    builtInPresets,
    userPresets,
    allPresets,
    favoritePresetIds,
    getPresetById,
    createUserPreset,
    // Only what changed is sent, so what another device saved since this
    // one read the prompt stays.
    updateUserPreset: (id: string, changes: PresetChanges) => {
      if (!raw.some((p) => p.id === id)) return
      const update: PresetUpdate = { id, updatedAt: Date.now() }
      for (const key of ['name', 'description', 'systemPrompt'] as const)
        if (changes[key] !== undefined) update[key] = changes[key]
      for (const key of ['model', 'webSearchEnabled'] as const)
        if (key in changes)
          Object.assign(update, { [key]: changes[key] ?? null })
      edit({ updatePromptPresets: [update] })
    },
    // A deleted preset is no longer a favorite or the default.
    deleteUserPreset: (id: string) => edit({ deletePromptPresetIds: [id] }),
    duplicatePreset: (id: string) => {
      const p = allPresets.find((p) => p.id === id)
      return p ? createUserPreset({ ...p, name: `${p.name} (copy)` }) : null
    },
    favoritePresets,
    isFavorite: (id: string) => favoritePresetIds.includes(id),
    // Only favorites that are still prompts take a slot, so one deleted on
    // another device does not block adding another.
    canAddFavorite: favoritePresets.length < MAX_FAVORITE_PRESETS,
    toggleFavorite: (id: string) => {
      if (favoritePresetIds.includes(id))
        edit({ removeFavoritePromptPresetIds: [id] })
      else if (favoritePresets.length < MAX_FAVORITE_PRESETS)
        edit({ addFavoritePromptPresetIds: [id] })
    },
    defaultPresetId,
    defaultPreset: getPresetById(defaultPresetId),
    // An empty string clears the default, as the harness and the iOS app
    // store it.
    setDefaultPreset: (id: string | null) => {
      void api
        .updateProfile({ defaultPromptPresetId: id ?? '' })
        .catch(reportProfileError)
    },
  }
}
