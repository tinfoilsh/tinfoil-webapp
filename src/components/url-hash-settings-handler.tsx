import { logInfo, logWarning } from '@/utils/error-handling'
import { useEffect, useRef } from 'react'
import type { SettingsTab } from './chat/settings-modal'

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

      // Import/export now live inside the chat tab; keep old links working.
      const legacyTabAliases: Record<string, SettingsTab> = {
        import: 'chat',
        export: 'chat',
      }
      const tabName = legacyTabAliases[parts[1]] ?? parts[1]
      const validTabs: SettingsTab[] = [
        'general',
        'chat',
        'personalization',
        'prompts',
        'cloud-sync',
        'account',
      ]

      if (!validTabs.includes(tabName as SettingsTab)) {
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

      onSettingsTabReady(tabName as SettingsTab)

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
