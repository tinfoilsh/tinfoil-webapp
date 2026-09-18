import { SETTINGS_TABS, type SettingsTab } from '@/constants/settings-tabs'
import { logInfo, logWarning } from '@/utils/error-handling'
import { useEffect, useRef } from 'react'

interface UrlHashSettingsHandlerProps {
  onSettingsTabReady: (tab: SettingsTab) => void
  isReady: boolean
}

export function UrlHashSettingsHandler({
  onSettingsTabReady,
  isReady,
}: UrlHashSettingsHandlerProps) {
  const hasProcessed = useRef(false)

  useEffect(() => {
    if (!isReady || hasProcessed.current) {
      return
    }

    // Mark as processed immediately to prevent re-processing when the settings
    // modal adds its own hash to the URL
    hasProcessed.current = true

    const processHashSettings = () => {
      const hash = window.location.hash

      if (!hash || hash.length <= 1) {
        return
      }

      const parts = hash.slice(1).split('/')

      if (parts[0] !== 'settings' || parts.length < 2) {
        return
      }

      // Import/export live inside the Data tab; keep old links working.
      const legacyTabAliases: Record<string, SettingsTab> = {
        import: 'data',
        export: 'data',
      }
      const tabName = legacyTabAliases[parts[1]] ?? parts[1]
      const tab = SETTINGS_TABS.find((candidate) => candidate === tabName)

      if (!tab) {
        logWarning('Invalid settings tab in URL fragment', {
          component: 'UrlHashSettingsHandler',
          metadata: { tabName },
        })
        return
      }

      logInfo('Opening settings from URL fragment', {
        component: 'UrlHashSettingsHandler',
        metadata: { tab: tabName },
      })

      onSettingsTabReady(tab)

      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      )
    }

    processHashSettings()
  }, [isReady, onSettingsTabReady])

  return null
}
