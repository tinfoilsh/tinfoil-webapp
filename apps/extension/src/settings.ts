import { logError } from '@tinfoil/chat-client/logging'
import {
  DEFAULT_EFFORT,
  type ReasoningEffort,
} from '@tinfoil/chat-client/models'
import { useEffect, useState } from 'react'
import { storage, type WxtStorageItem } from 'wxt/utils/storage'
import type { Catalog } from './model-choice'

// Whether an action that changes a page waits for the user's approval.
export const reviewActions = storage.defineItem<boolean>(
  'local:reviewActions',
  { fallback: false },
)

// The model the user chose for their tasks, how hard it works, and how hard
// Auto works when it is the model.
export const chosenModel = storage.defineItem<string | null>('local:model', {
  fallback: null,
})
export const chosenEffort = storage.defineItem<ReasoningEffort>(
  'local:reasoningEffort',
  { fallback: DEFAULT_EFFORT },
)
export const chosenAutoLevel = storage.defineItem<string | null>(
  'local:autoIntelligence',
  { fallback: null },
)

// What the chat service last offered, which the settings page chooses from
// while no side panel is open, and whether the open panel has verified the
// service it talks to.
export const catalog = storage.defineItem<Catalog | null>('local:catalog', {
  fallback: null,
})
export const privacyVerified = storage.defineItem<boolean>(
  'session:privacyVerified',
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
