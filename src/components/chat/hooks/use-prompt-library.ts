import {
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_FAVORITE_PROMPT_PRESETS,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PiNotePencil } from 'react-icons/pi'
import { BUILT_IN_PROMPT_PRESETS } from '../prompts/built-in-presets'
import type { PromptPreset, UserPromptPreset } from '../prompts/types'

const COMPONENT = 'usePromptLibrary'

const USER_PRESET_ID_PREFIX = 'user:'

const PROMPT_LIBRARY_CHANGED_EVENT = 'promptLibraryChanged'

export const MAX_FAVORITE_PRESETS = 3

const DEFAULT_USER_PRESET_ICON = PiNotePencil

type UsePromptLibraryReturn = {
  builtInPresets: PromptPreset[]
  userPresets: PromptPreset[]
  allPresets: PromptPreset[]
  getPresetById: (id: string | null | undefined) => PromptPreset | null
  createUserPreset: (
    input: Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>,
  ) => PromptPreset
  updateUserPreset: (
    id: string,
    patch: Partial<
      Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>
    >,
  ) => void
  deleteUserPreset: (id: string) => void
  duplicatePreset: (sourceId: string) => PromptPreset | null
  favoritePresetIds: string[]
  favoritePresets: PromptPreset[]
  isFavorite: (id: string) => boolean
  canAddFavorite: boolean
  toggleFavorite: (id: string) => void
}

function safeReadUserPresets(): UserPromptPreset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(USER_PREFS_CUSTOM_PROMPT_PRESETS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is UserPromptPreset =>
        p &&
        typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.description === 'string' &&
        typeof p.systemPrompt === 'string' &&
        typeof p.createdAt === 'number' &&
        typeof p.updatedAt === 'number',
    )
  } catch (err) {
    logError('Failed to parse user prompt presets', err, {
      component: COMPONENT,
    })
    return []
  }
}

function safeWriteUserPresets(presets: UserPromptPreset[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify(presets),
    )
    window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_CHANGED_EVENT))
  } catch (err) {
    logError('Failed to persist user prompt presets', err, {
      component: COMPONENT,
    })
  }
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

function generateUserPresetId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${USER_PRESET_ID_PREFIX}${Date.now().toString(36)}-${random}`
}

function toPromptPreset(stored: UserPromptPreset): PromptPreset {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    Icon: DEFAULT_USER_PRESET_ICON,
    systemPrompt: stored.systemPrompt,
    isBuiltIn: false,
  }
}

export function usePromptLibrary(): UsePromptLibraryReturn {
  const [userPresetsRaw, setUserPresetsRaw] = useState<UserPromptPreset[]>([])
  const [favoritePresetIds, setFavoritePresetIds] = useState<string[]>([])

  useEffect(() => {
    setUserPresetsRaw(safeReadUserPresets())
    setFavoritePresetIds(safeReadFavoriteIds())

    const handleChange = () => {
      setUserPresetsRaw(safeReadUserPresets())
      setFavoritePresetIds(safeReadFavoriteIds())
    }
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === USER_PREFS_CUSTOM_PROMPT_PRESETS ||
        event.key === USER_PREFS_FAVORITE_PROMPT_PRESETS
      ) {
        setUserPresetsRaw(safeReadUserPresets())
        setFavoritePresetIds(safeReadFavoriteIds())
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
    (
      input: Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>,
    ): PromptPreset => {
      const now = Date.now()
      const newPreset: UserPromptPreset = {
        id: generateUserPresetId(),
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        createdAt: now,
        updatedAt: now,
      }
      const next = [...safeReadUserPresets(), newPreset]
      safeWriteUserPresets(next)
      return toPromptPreset(newPreset)
    },
    [],
  )

  const updateUserPreset = useCallback(
    (
      id: string,
      patch: Partial<
        Pick<UserPromptPreset, 'name' | 'description' | 'systemPrompt'>
      >,
    ) => {
      const current = safeReadUserPresets()
      const idx = current.findIndex((p) => p.id === id)
      if (idx === -1) return
      const updated: UserPromptPreset = {
        ...current[idx],
        ...patch,
        updatedAt: Date.now(),
      }
      const next = [...current]
      next[idx] = updated
      safeWriteUserPresets(next)
    },
    [],
  )

  const deleteUserPreset = useCallback((id: string) => {
    const next = safeReadUserPresets().filter((p) => p.id !== id)
    safeWriteUserPresets(next)
    const favorites = safeReadFavoriteIds()
    if (favorites.includes(id)) {
      safeWriteFavoriteIds(favorites.filter((favoriteId) => favoriteId !== id))
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
      const userSource = safeReadUserPresets().find((p) => p.id === sourceId)
      if (!userSource) return null
      return createUserPreset({
        name: `${userSource.name} (copy)`,
        description: userSource.description,
        systemPrompt: userSource.systemPrompt,
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

  const canAddFavorite = favoritePresetIds.length < MAX_FAVORITE_PRESETS

  const toggleFavorite = useCallback((id: string) => {
    const current = safeReadFavoriteIds()
    if (current.includes(id)) {
      safeWriteFavoriteIds(current.filter((favoriteId) => favoriteId !== id))
    } else if (current.length < MAX_FAVORITE_PRESETS) {
      safeWriteFavoriteIds([...current, id])
    }
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
  }
}
