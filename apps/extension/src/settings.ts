import { logError } from '@tinfoil/chat-client/logging'
import { useEffect, useState } from 'react'
import { storage, type WxtStorageItem } from 'wxt/utils/storage'

// Whether an action that changes a page waits for the user's approval.
export const reviewActions = storage.defineItem<boolean>(
  'local:reviewActions',
  { fallback: false },
)

// A setting as the extension stores it, kept current as any page changes it.
// It has no value until the stored one is read.
export function useSetting<T>(
  item: WxtStorageItem<T, Record<string, unknown>>,
): [T | undefined, (value: T) => void] {
  const [value, setValue] = useState<T>()
  useEffect(() => {
    let current = true
    const unwatch = item.watch((next) => {
      if (current) setValue(next)
    })
    item.getValue().then(
      (stored) => {
        if (current) setValue(stored)
      },
      (cause) => logError('Unable to read a setting', cause),
    )
    return () => {
      current = false
      unwatch()
    }
  }, [item])
  return [
    value,
    (next) => {
      setValue(next)
      item.setValue(next).catch((cause) => {
        logError('Unable to save a setting', cause)
        // The control goes back to what is stored, which is what applies.
        return item.getValue().then(setValue, (failure) => {
          logError('Unable to read a setting', failure)
        })
      })
    },
  ]
}
