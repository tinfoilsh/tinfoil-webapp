/**
 * Thin React binding over {@link BrokerStatusPoller}. Owns the poller lifecycle
 * (start on mount, stop on unmount) and probes immediately on `visibilitychange`
 * so tabbing back from installing the broker reflects instantly. All cadence /
 * indicator logic lives in the poller (and is unit-tested there); this file is
 * deliberately minimal.
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { BrokerClient } from './broker-client'
import { BrokerStatusPoller, type BrokerStatusState } from './status-poller'

const INITIAL: BrokerStatusState = {
  status: null,
  readiness: 'absent',
  indicator: 'disconnected',
  probing: false,
  lastUpdated: null,
}

export interface UseBrokerStatusOptions {
  /** Gate polling (e.g. only when computer-use is plausibly relevant). Default true. */
  enabled?: boolean
  /** Inject a client (tests / custom origin). Defaults to a fresh BrokerClient. */
  client?: BrokerClient
}

/**
 * Subscribe to live broker `/status`. Returns the latest poller state; the
 * caller derives tool exposure via `computerUseAvailability({ status, model })`
 * so the indicator and the toolset come from the same source.
 */
export function useBrokerStatus(
  opts: UseBrokerStatusOptions = {},
): BrokerStatusState {
  const { enabled = true, client } = opts
  const [state, setState] = useState<BrokerStatusState>(INITIAL)
  const pollerRef = useRef<BrokerStatusPoller | null>(null)

  useEffect(() => {
    if (!enabled) return
    const c = client ?? new BrokerClient()
    const poller = new BrokerStatusPoller({
      getStatus: (signal) => c.getStatus(signal),
      onUpdate: setState,
    })
    pollerRef.current = poller
    poller.start()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poller.refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      poller.stop()
      pollerRef.current = null
    }
  }, [enabled, client])

  // When disabled, report the neutral state without writing it during the
  // effect (the poller isn't running, so `state` would otherwise go stale).
  return enabled ? state : INITIAL
}
