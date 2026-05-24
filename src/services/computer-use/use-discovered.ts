/**
 * Reactive hook for "has the user *ever* engaged with computer-use" — used to
 * pick the right tooltip on the toggle when the driver is absent:
 *   - Never engaged ("first-touch"): the toggle hints toward the model
 *     ("Ask Tin about computer use") so a curious user can discover the
 *     feature via the install funnel.
 *   - Already engaged: the toggle gives the actionable cue ("Computer driver
 *     not connected — start it").
 *
 * "Engaged" today means: a refresh credential has *ever* been stored on this
 * browser (i.e. they completed a pairing at some point). That's sticky and
 * survives uninstall/restart of the driver — exactly the right signal for "do
 * they know what this is."
 */
'use client'

import { useEffect, useState } from 'react'
import { PAIR_CHANGE_EVENT } from './credential-store'

// Key kept in sync with credential-store.ts (which writes it on first
// pairing). Keep this string identical there if you ever rename.
const STORAGE_KEY = 'tinfoil-computer-use-discovered'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function readDiscovered(): boolean {
  return storage()?.getItem(STORAGE_KEY) === '1'
}

/**
 * Record that the user has engaged with computer-use. Idempotent (a no-op
 * once set). Called explicitly on engagement signals other than pairing —
 * e.g. when the user clicks the toggle for the first time. Pairing already
 * sets the flag from `setRefreshCredential` (no call needed).
 */
export function markComputerUseDiscovered(): void {
  if (readDiscovered()) return
  storage()?.setItem(STORAGE_KEY, '1')
  // Reuse the same event channel as credential changes — same-tab consumers
  // are already listening, no need to add a second event name.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PAIR_CHANGE_EVENT))
  }
}

export function useComputerUseDiscovered(): boolean {
  const [discovered, setDiscovered] = useState<boolean>(() => readDiscovered())
  useEffect(() => {
    const update = () => setDiscovered(readDiscovered())
    window.addEventListener('storage', update)
    window.addEventListener(PAIR_CHANGE_EVENT, update)
    update()
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener(PAIR_CHANGE_EVENT, update)
    }
  }, [])
  return discovered
}
