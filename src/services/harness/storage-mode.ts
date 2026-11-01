import { SETTINGS_LOCAL_ONLY_MODE_ENABLED } from '@/constants/storage-keys'
import { isLocalOnlyModeEnabled } from '@/utils/cloud-sync-settings'
import { useSyncExternalStore } from 'react'

const LOCAL_ONLY_MODE_CHANGED_EVENT = 'localOnlyModeChanged'

function subscribeTo(key: string, event: string) {
  return (listener: () => void) => {
    const storage = (change: StorageEvent) => {
      if (change.key === key || change.key === null) listener()
    }
    window.addEventListener(event, listener)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(event, listener)
      window.removeEventListener('storage', storage)
    }
  }
}

const subscribeLocalChats = subscribeTo(
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
  LOCAL_ONLY_MODE_CHANGED_EVENT,
)
const off = () => false

// "Enable local chats": with cloud sync on, chats started from the Local tab
// stay on this device.
export function useLocalChatsSetting(): boolean {
  return useSyncExternalStore(subscribeLocalChats, isLocalOnlyModeEnabled, off)
}
