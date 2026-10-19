import { ENTER_TO_NEWLINE_CHANGED_EVENT } from '@/constants/settings-events'
import { SETTINGS_ENTER_TO_NEWLINE_ENABLED } from '@/constants/storage-keys'
import { useSyncExternalStore } from 'react'

const subscribe = (onStoreChange: () => void) => {
  // A null key means localStorage.clear(), which also resets this setting.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SETTINGS_ENTER_TO_NEWLINE_ENABLED) {
      onStoreChange()
    }
  }
  window.addEventListener(ENTER_TO_NEWLINE_CHANGED_EVENT, onStoreChange)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(ENTER_TO_NEWLINE_CHANGED_EVENT, onStoreChange)
    window.removeEventListener('storage', handleStorage)
  }
}

const getSnapshot = (): boolean => {
  try {
    return localStorage.getItem(SETTINGS_ENTER_TO_NEWLINE_ENABLED) === 'true'
  } catch {
    // Storage can be blocked (e.g. disabled cookies); keep the default.
    return false
  }
}

const getServerSnapshot = (): boolean => false

/**
 * Whether pressing Enter in a chat textarea should insert a newline instead
 * of submitting. When enabled, submitting is done via Cmd/Ctrl+Enter or the
 * send button. Reacts to same-tab settings changes and cross-tab storage
 * events.
 */
export const useEnterToNewline = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
