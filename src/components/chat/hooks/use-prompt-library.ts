import {
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PiNotePencil } from 'react-icons/pi'
import { BUILT_IN_PROMPT_PRESETS } from '../prompts/built-in-presets'
import {
  PROMPT_LIBRARY_CHANGED_EVENT,
  generateUserPresetId,
  migrateLegacyCustomPrompt,
  readDefaultPresetId,
  readUserPresets,
  writeDefaultPresetId,
  writeUserPresets,
} from '../prompts/default-preset'
import type { PromptPreset, UserPromptPreset } from '../prompts/types'

const COMPONENT = 'usePromptLibrary'

export const MAX_FAVORITE_PRESETS = 3

const DEFAULT_USER_PRESET_ICON = PiNotePencil

export type UserPresetInput = Pick<
  UserPromptPreset,
  'name' | 'description' | 'systemPrompt' | 'model' | 'webSearchEnabled'
>

type UsePromptLibraryReturn = {
  builtInPresets: PromptPreset[]
  userPresets: PromptPreset[]
  allPresets: PromptPreset[]
  getPresetById: (id: string | null | undefined) => PromptPreset | null
  createUserPreset: (input: UserPresetInput) => PromptPreset
  updateUserPreset: (id: string, patch: Partial<UserPresetInput>) => void
  deleteUserPreset: (id: string) => void
  duplicatePreset: (sourceId: string) => PromptPreset | null
  favoritePresetIds: string[]
  favoritePresets: PromptPreset[]
  isFavorite: (id: string) => boolean
  canAddFavorite: boolean
  toggleFavorite: (id: string) => void
  defaultPresetId: string | null
  defaultPreset: PromptPreset | null
  setDefaultPreset: (id: string | null) => void
}

function safeReadFavoriteIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(USER_PREFS_FAVORITE_PROMPT_PRESETS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch (err) {
    logError('Failed to parse favorite prompt presets', err, {
      component: COMPONENT,
    })
    return []
  }
}

function safeWriteFavoriteIds(ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      USER_PREFS_FAVORITE_PROMPT_PRESETS,
      JSON.stringify(ids),
    )
    window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_CHANGED_EVENT))
  } catch (err) {
    logError('Failed to persist favorite prompt presets', err, {
      component: COMPONENT,
    })
  }
}

function toPromptPreset(stored: UserPromptPreset): PromptPreset {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    Icon: DEFAULT_USER_PRESET_ICON,
    systemPrompt: stored.systemPrompt,
    isBuiltIn: false,
    model: stored.model,
    webSearchEnabled: stored.webSearchEnabled,
  }
}

// Optional settings are omitted rather than written as undefined so the
// serialized preset matches the wire format shared with the iOS app.
function withPresetSettings<T extends object>(
  base: T,
  input: Partial<UserPresetInput>,
): T {
  const next = { ...base } as T & Partial<UserPresetInput>
  if ('model' in input) {
    if (input.model === undefined) delete next.model
    else next.model = input.model
  }
  if ('webSearchEnabled' in input) {
    if (input.webSearchEnabled === undefined) delete next.webSearchEnabled
    else next.webSearchEnabled = input.webSearchEnabled
  }
  return next
}

export function usePromptLibrary(): UsePromptLibraryReturn {
  const [userPresetsRaw, setUserPresetsRaw] = useState<UserPromptPreset[]>([])
  const [favoritePresetIds, setFavoritePresetIds] = useState<string[]>([])
  const [defaultPresetId, setDefaultPresetId] = useState<string | null>(null)

  useEffect(() => {
    migrateLegacyCustomPrompt()
    const refresh = () => {
      setUserPresetsRaw(readUserPresets())
      setFavoritePresetIds(safeReadFavoriteIds())
      setDefaultPresetId(readDefaultPresetId())
    }
    refresh()

    const handleChange = () => refresh()
    const handleStorage = (event: StorageEvent) => {
      // A null key means localStorage.clear() in another tab.
      if (
        event.key === null ||
        event.key === USER_PREFS_CUSTOM_PROMPT_PRESETS ||
        event.key === USER_PREFS_FAVORITE_PROMPT_PRESETS ||
        event.key === USER_PREFS_DEFAULT_PROMPT_PRESET_ID
      ) {
        refresh()
      }
    }

    window.addEventListener(PROMPT_LIBRARY_CHANGED_EVENT, handleChange)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(PROMPT_LIBRARY_CHANGED_EVENT, handleChange)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const userPresets: PromptPreset[] = useMemo(
    () => userPresetsRaw.map(toPromptPreset),
    [userPresetsRaw],
  )

  const allPresets = useMemo(
    () => [...BUILT_IN_PROMPT_PRESETS, ...userPresets],
    [userPresets],
  )

  const getPresetById = useCallback(
    (id: string | null | undefined): PromptPreset | null => {
      if (!id) return null
      return allPresets.find((p) => p.id === id) ?? null
    },
    [allPresets],
  )

  const createUserPreset = useCallback(
    (input: UserPresetInput): PromptPreset => {
      const now = Date.now()
      const newPreset: UserPromptPreset = withPresetSettings(
        {
          id: generateUserPresetId(),
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          createdAt: now,
          updatedAt: now,
        },
        input,
      )
      const next = [...readUserPresets(), newPreset]
      writeUserPresets(next)
      return toPromptPreset(newPreset)
    },
    [],
  )

  const updateUserPreset = useCallback(
    (id: string, patch: Partial<UserPresetInput>) => {
      const current = readUserPresets()
      const idx = current.findIndex((p) => p.id === id)
      if (idx === -1) return
      const updated: UserPromptPreset = withPresetSettings(
        {
          ...current[idx],
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && {
            description: patch.description,
          }),
          ...(patch.systemPrompt !== undefined && {
            systemPrompt: patch.systemPrompt,
          }),
          updatedAt: Date.now(),
        },
        patch,
      )
      const next = [...current]
      next[idx] = updated
      writeUserPresets(next)
    },
    [],
  )

  const deleteUserPreset = useCallback((id: string) => {
    const next = readUserPresets().filter((p) => p.id !== id)
    writeUserPresets(next)
    const favorites = safeReadFavoriteIds()
    if (favorites.includes(id)) {
      safeWriteFavoriteIds(favorites.filter((favoriteId) => favoriteId !== id))
    }
    if (readDefaultPresetId() === id) {
      writeDefaultPresetId(null)
    }
  }, [])

  const duplicatePreset = useCallback(
    (sourceId: string): PromptPreset | null => {
      const builtIn = BUILT_IN_PROMPT_PRESETS.find((p) => p.id === sourceId)
      if (builtIn) {
        return createUserPreset({
          name: `${builtIn.name} (copy)`,
          description: builtIn.description,
          systemPrompt: builtIn.systemPrompt,
        })
      }
      const userSource = readUserPresets().find((p) => p.id === sourceId)
      if (!userSource) return null
      return createUserPreset({
        name: `${userSource.name} (copy)`,
        description: userSource.description,
        systemPrompt: userSource.systemPrompt,
        model: userSource.model,
        webSearchEnabled: userSource.webSearchEnabled,
      })
    },
    [createUserPreset],
  )

  const favoritePresets = useMemo(
    () =>
      favoritePresetIds
        .map((id) => allPresets.find((p) => p.id === id))
        .filter((p): p is PromptPreset => p != null),
    [favoritePresetIds, allPresets],
  )

  const isFavorite = useCallback(
    (id: string) => favoritePresetIds.includes(id),
    [favoritePresetIds],
  )

  // Capacity is measured against favorites that actually resolve to a
  // preset. Stale ids (e.g. a custom preset deleted on another device, or
  // one not yet synced here) must never count toward the cap and block
  // adding a valid favorite.
  const canAddFavorite = favoritePresets.length < MAX_FAVORITE_PRESETS

  const toggleFavorite = useCallback(
    (id: string) => {
      const current = safeReadFavoriteIds()
      if (current.includes(id)) {
        safeWriteFavoriteIds(current.filter((favoriteId) => favoriteId !== id))
        return
      }
      const resolvableCount = current.filter((favoriteId) =>
        allPresets.some((preset) => preset.id === favoriteId),
      ).length
      if (resolvableCount < MAX_FAVORITE_PRESETS) {
        safeWriteFavoriteIds([...current, id])
      }
    },
    [allPresets],
  )

  // A stale id (preset deleted elsewhere or not yet synced here) resolves to
  // null so callers fall back to the server prompt instead of a missing one.
  const defaultPreset = getPresetById(defaultPresetId)

  const setDefaultPreset = useCallback((id: string | null) => {
    writeDefaultPresetId(id)
  }, [])

  return {
    builtInPresets: BUILT_IN_PROMPT_PRESETS,
    userPresets,
    allPresets,
    getPresetById,
    createUserPreset,
    updateUserPreset,
    deleteUserPreset,
    duplicatePreset,
    favoritePresetIds,
    favoritePresets,
    isFavorite,
    canAddFavorite,
    toggleFavorite,
    defaultPresetId,
    defaultPreset,
    setDefaultPreset,
  }
}
