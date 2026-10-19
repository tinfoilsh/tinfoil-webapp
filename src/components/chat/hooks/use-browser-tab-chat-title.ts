import { BROWSER_TAB_CHAT_TITLE_CHANGED_EVENT } from '@/constants/settings-events'
import { SETTINGS_BROWSER_TAB_CHAT_TITLE_ENABLED } from '@/constants/storage-keys'
import { useSyncExternalStore } from 'react'

const subscribe = (onStoreChange: () => void) => {
  // A null key means localStorage.clear(), which also resets this setting.
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === SETTINGS_BROWSER_TAB_CHAT_TITLE_ENABLED
    ) {
      onStoreChange()
    }
  }
  window.addEventListener(BROWSER_TAB_CHAT_TITLE_CHANGED_EVENT, onStoreChange)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(
      BROWSER_TAB_CHAT_TITLE_CHANGED_EVENT,
      onStoreChange,
    )
    window.removeEventListener('storage', handleStorage)
  }
}

const getSnapshot = (): boolean => {
  try {
    // Unset means the user never opted out, so chat titles are shown.
    return (
      localStorage.getItem(SETTINGS_BROWSER_TAB_CHAT_TITLE_ENABLED) !== 'false'
    )
  } catch {
    // Storage can be blocked (e.g. disabled cookies); keep the default.
    return true
  }
}

const getServerSnapshot = (): boolean => true

/**
 * Whether the active chat's title should appear in the browser tab. When
 * disabled, the tab shows only the base app title so chat contents are not
 * exposed in tab strips, history, or window switchers. Reacts to same-tab
 * settings changes and cross-tab storage events.
 */
export const useBrowserTabChatTitle = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
