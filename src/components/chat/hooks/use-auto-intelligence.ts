import {
  DEFAULT_AUTO_INTELLIGENCE_LEVEL,
  isAutoIntelligenceLevelId,
  type AutoIntelligenceLevelId,
} from '@/config/models'
import { SETTINGS_AUTO_INTELLIGENCE } from '@/constants/storage-keys'
import { useCallback, useEffect, useState } from 'react'

const AUTO_INTELLIGENCE_CHANGED_EVENT = 'autoIntelligenceChanged'

/**
 * Tracks the Auto intelligence slider position. Persisted device-locally, like
 * the selected model, and broadcast so every mounted picker stays in sync.
 * Reads storage in the lazy initializer so the first render already reflects
 * the saved level and an early submit does not send the default.
 */
export function useAutoIntelligence() {
  const [autoIntelligence, setAutoIntelligenceState] =
    useState<AutoIntelligenceLevelId>(() => {
      if (typeof window === 'undefined') return DEFAULT_AUTO_INTELLIGENCE_LEVEL
      const saved = window.localStorage.getItem(SETTINGS_AUTO_INTELLIGENCE)
      return isAutoIntelligenceLevelId(saved)
        ? saved
        : DEFAULT_AUTO_INTELLIGENCE_LEVEL
    })

  useEffect(() => {
    const handleChanged = (event: CustomEvent<AutoIntelligenceLevelId>) => {
      if (isAutoIntelligenceLevelId(event.detail)) {
        setAutoIntelligenceState(event.detail)
      }
    }
    // Other tabs write the same key; a null key means storage was cleared.
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== SETTINGS_AUTO_INTELLIGENCE) return
      setAutoIntelligenceState(
        isAutoIntelligenceLevelId(event.newValue)
          ? event.newValue
          : DEFAULT_AUTO_INTELLIGENCE_LEVEL,
      )
    }
    window.addEventListener(
      AUTO_INTELLIGENCE_CHANGED_EVENT,
      handleChanged as EventListener,
    )
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(
        AUTO_INTELLIGENCE_CHANGED_EVENT,
        handleChanged as EventListener,
      )
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const setAutoIntelligence = useCallback((level: AutoIntelligenceLevelId) => {
    setAutoIntelligenceState(level)
    localStorage.setItem(SETTINGS_AUTO_INTELLIGENCE, level)
    window.dispatchEvent(
      new CustomEvent(AUTO_INTELLIGENCE_CHANGED_EVENT, { detail: level }),
    )
  }, [])

  return { autoIntelligence, setAutoIntelligence }
}
