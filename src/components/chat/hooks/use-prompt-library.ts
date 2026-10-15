import type { BaseModel } from '@/config/models'
import { useHarness } from '@/services/harness/provider'
import { reportHarnessError } from '@/services/harness/runtime'
import {
  TfCode2,
  TfLightbulb,
  TfLightning,
  TfMask,
  TfScholar,
  TfTranslation,
  TfWriting,
  TfWriting2,
  type IconType,
} from '@tinfoilsh/tinfoil-icons'
import { isPresetModelAvailable } from '../prompts/preset-settings'
import type {
  PromptPreset,
  PromptPresetSettings,
  UserPromptPreset,
} from '../prompts/types'
const presetIcons: Record<string, IconType> = {
  student: TfScholar,
  code: TfCode2,
  'pencil-line': TfWriting2,
  lightbulb: TfLightbulb,
  translate: TfTranslation,
  lightning: TfLightning,
  'mask-happy': TfMask,
}
export const MAX_FAVORITE_PRESETS = 3

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
  const raw: UserPromptPreset[] = profile.customPromptPresets ?? []
  const userPresets: PromptPreset[] = raw.map((p) => ({
    ...p,
    Icon: TfWriting,
    isBuiltIn: false,
  }))
  const builtInPresets: PromptPreset[] = (session?.presets ?? []).map((p) => ({
    ...p,
    description: p.description ?? '',
    Icon: presetIcons[p.icon ?? ''] ?? TfWriting,
    isBuiltIn: true,
    systemPrompt: p.systemPrompt ?? '',
  }))
  const allPresets = [...builtInPresets, ...userPresets]
  const getPresetById = (id: string | null | undefined) =>
    allPresets.find((p) => p.id === id) ?? null
  const favoritePresetIds: string[] = profile.favoritePromptPresetIds ?? []
  // The harness keeps the preset new chats start with, and stamps it on a
  // stored chat's first turn. An older harness has no such setting.
  const canSetDefaultPreset = !!session?.features.defaultPromptPreset
  const defaultPresetId =
    canSetDefaultPreset &&
    typeof profile.defaultPromptPresetId === 'string' &&
    profile.defaultPromptPresetId
      ? profile.defaultPromptPresetId
      : null
  const save = (
    change: (presets: UserPromptPreset[]) => UserPromptPreset[],
  ) => {
    void api
      .updateProfile((current) => ({
        customPromptPresets: change(current.customPromptPresets ?? []),
      }))
      .catch(reportHarnessError)
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
    save((presets) => [...presets, p])
    return { ...p, Icon: TfWriting, isBuiltIn: false }
  }
  return {
    builtInPresets,
    userPresets,
    allPresets,
    favoritePresetIds,
    getPresetById,
    createUserPreset,
    updateUserPreset: (
      id: string,
      patch: Partial<Omit<UserPromptPreset, keyof PromptPresetSettings>> &
        PromptPresetSettings,
    ) =>
      save((presets) =>
        presets.map((p) =>
          p.id === id
            ? withSettings({ ...p, ...patch, updatedAt: Date.now() }, patch)
            : p,
        ),
      ),
    // A deleted preset is no longer a favorite or the default.
    deleteUserPreset: (id: string) => {
      void api
        .updateProfile((current) => ({
          customPromptPresets: (
            (current.customPromptPresets ?? []) as UserPromptPreset[]
          ).filter((p) => p.id !== id),
          favoritePromptPresetIds: (
            (current.favoritePromptPresetIds ?? []) as string[]
          ).filter((favorite) => favorite !== id),
          ...(canSetDefaultPreset && current.defaultPromptPresetId === id
            ? { defaultPromptPresetId: '' }
            : {}),
        }))
        .catch(reportHarnessError)
    },
    duplicatePreset: (id: string) => {
      const p = allPresets.find((p) => p.id === id)
      return p ? createUserPreset({ ...p, name: `${p.name} copy` }) : null
    },
    favoritePresets: favoritePresetIds.flatMap((id) =>
      allPresets.filter((p) => p.id === id),
    ),
    isFavorite: (id: string) => favoritePresetIds.includes(id),
    canAddFavorite: favoritePresetIds.length < MAX_FAVORITE_PRESETS,
    toggleFavorite: (id: string) => {
      const ids = favoritePresetIds.includes(id)
        ? favoritePresetIds.filter((p) => p !== id)
        : [...favoritePresetIds, id].slice(0, MAX_FAVORITE_PRESETS)
      void api
        .updateProfile({ favoritePromptPresetIds: ids })
        .catch(reportHarnessError)
    },
    // Clears the model of saved prompts whose model the catalog no longer
    // offers, so a retired model does not linger. Returns their ids.
    pruneUnavailableModels: (models: BaseModel[]) => {
      const stale = raw
        .filter(
          (p) =>
            typeof p.model === 'string' &&
            !isPresetModelAvailable(p.model, models),
        )
        .map((p) => p.id)
      if (!models.length || !stale.length) return []
      save((presets) =>
        presets.map((p) =>
          stale.includes(p.id)
            ? withSettings(
                { ...p, updatedAt: Date.now() },
                { model: undefined },
              )
            : p,
        ),
      )
      return stale
    },
    canSetDefaultPreset,
    defaultPresetId,
    defaultPreset: getPresetById(defaultPresetId),
    // An empty string clears the default, as the harness and the iOS app
    // store it.
    setDefaultPreset: (id: string | null) => {
      if (!canSetDefaultPreset) return
      void api
        .updateProfile({ defaultPromptPresetId: id ?? '' })
        .catch(reportHarnessError)
    },
  }
}
