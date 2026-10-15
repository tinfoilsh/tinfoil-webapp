import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
} from '@/constants/storage-keys'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
  isLocalOnlyModeEnabled,
} from '@/utils/cloud-sync-settings'
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

const subscribeCloudSync = subscribeTo(
  SETTINGS_CLOUD_SYNC_ENABLED,
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
)
const subscribeLocalChats = subscribeTo(
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
  LOCAL_ONLY_MODE_CHANGED_EVENT,
)
const off = () => false

// The device's cloud sync choice. A signed-in account without it keeps every
// chat on this device, as does a signed-out visitor.
export function useCloudSyncSetting(): boolean {
  return useSyncExternalStore(subscribeCloudSync, isCloudSyncEnabled, off)
}

// "Enable local chats": with cloud sync on, chats started from the Local tab
// stay on this device.
export function useLocalChatsSetting(): boolean {
  return useSyncExternalStore(subscribeLocalChats, isLocalOnlyModeEnabled, off)
}
