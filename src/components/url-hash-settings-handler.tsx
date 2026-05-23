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

      const tabName = parts[1]
      const validTabs: SettingsTab[] = [
        'general',
        'chat',
        'personalization',
        'prompts',
        'cloud-sync',
        'import',
        'export',
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
