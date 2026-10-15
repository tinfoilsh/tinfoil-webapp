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
import type { PromptPreset, UserPromptPreset } from '../prompts/types'
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
  const favoritePresetIds: string[] = profile.favoritePromptPresetIds ?? []
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
    input: Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>,
  ) => {
    const p = {
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      id: `user:${crypto.randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    save((presets) => [...presets, p])
    return { ...p, Icon: TfWriting, isBuiltIn: false }
  }
  return {
    builtInPresets,
    userPresets,
    allPresets,
    favoritePresetIds,
    getPresetById: (id: string | null | undefined) =>
      allPresets.find((p) => p.id === id) ?? null,
    createUserPreset,
    updateUserPreset: (id: string, patch: Partial<UserPromptPreset>) =>
      save((presets) =>
        presets.map((p) =>
          p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
        ),
      ),
    deleteUserPreset: (id: string) =>
      save((presets) => presets.filter((p) => p.id !== id)),
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
  }
}
