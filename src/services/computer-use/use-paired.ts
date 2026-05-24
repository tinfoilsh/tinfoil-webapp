/**
 * Reactive hook for the driver pairing state — whether this browser has a
 * stored refresh credential. Used by the "Connect" banner and the
 * unpaired-toggle behavior to react to pairing happening, or to a 401-driven
 * credential clear, without polling.
 *
 * Subscribes to two signals:
 *   - The `storage` event (cross-tab — another window paired/unpaired).
 *   - The `PAIR_CHANGE_EVENT` (same-tab — this window paired/unpaired,
 *     dispatched by credential-store.ts's setters).
 */
'use client'

import { useEffect, useState } from 'react'
import { isPaired, PAIR_CHANGE_EVENT } from './credential-store'

export function usePaired(): boolean {
  const [paired, setPaired] = useState<boolean>(() => isPaired())

  useEffect(() => {
    const update = () => setPaired(isPaired())
    window.addEventListener('storage', update)
    window.addEventListener(PAIR_CHANGE_EVENT, update)
    // Re-read on mount in case the value changed between the lazy initial
    // state and the effect running (HMR, race with another effect).
    update()
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener(PAIR_CHANGE_EVENT, update)
    }
  }, [])

  return paired
}
