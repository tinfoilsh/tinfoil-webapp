import { logError, logWarning } from '@/utils/error-handling'
import {
  pull,
  type PullItem,
  type PullKey,
  type Scope,
} from '../sync-enclave/sync-api'
import { migrationKeys } from './cek-encoding'

const LEGACY_KEY_PROBE_LIMIT = 5

const LEGACY_KEY_PROBE_SCOPES = [
  'chat',
  'profile',
  'project',
  'project_document',
] as const satisfies readonly Scope[]

export type LegacyKeyProbeOutcome =
  | 'decryptable'
  | 'undecryptable'
  | 'no_sample'
  | 'transient_failure'

export interface LegacyKeyProbeResult {
  outcome: LegacyKeyProbeOutcome
  sampledDecryptable: boolean
  sampledUndecryptable: boolean
}

export function legacyKeyProbeAllowsBinding(
  result: LegacyKeyProbeResult,
): boolean {
  return result.outcome === 'decryptable' || result.outcome === 'no_sample'
}

/**
 * Thrown when a key would be bound to the enclave even though the
 * existing remote data proves it can never unseal that data. Callers
 * surface this as a distinct, user-facing message rather than a
 * generic failure.
 */
export class LegacyKeyMismatchError extends Error {
  constructor() {
    super('Local key cannot unlock existing cloud data')
    this.name = 'LegacyKeyMismatchError'
  }
}

export async function probeLegacyDataWithLocalKeys(opts?: {
  keys?: PullKey[]
  action?: string
}): Promise<LegacyKeyProbeResult> {
  const keys = opts?.keys ?? migrationKeys()
  const action = opts?.action ?? 'probeLegacyDataWithLocalKeys'
  if (keys.length === 0) {
    return {
      outcome: 'undecryptable',
      sampledDecryptable: false,
      sampledUndecryptable: false,
    }
  }

  let sawDecryptableRow = false
  let sawUndecryptableRow = false

  for (const scope of LEGACY_KEY_PROBE_SCOPES) {
    let items: PullItem[]
    try {
      const resp = await pull(
        scope === 'profile'
          ? { scope, ids: ['profile'], keys }
          : { scope, all: true, limit: LEGACY_KEY_PROBE_LIMIT, keys },
      )
      items = resp.items
    } catch (err) {
      logError('Legacy data key probe failed', err, {
        component: 'LegacyKeyProbe',
        action,
        metadata: { scope },
      })
      return {
        outcome: 'transient_failure',
        sampledDecryptable: sawDecryptableRow,
        sampledUndecryptable: sawUndecryptableRow,
      }
    }

    for (const item of items) {
      if (item.ok) {
        sawDecryptableRow = true
      } else if (item.code === 'UNKNOWN_KEY') {
        sawUndecryptableRow = true
      }
    }
  }

  if (sawUndecryptableRow) {
    logWarning('Legacy data key probe found rows local keys cannot unseal', {
      component: 'LegacyKeyProbe',
      action,
    })
    return {
      outcome: 'undecryptable',
      sampledDecryptable: sawDecryptableRow,
      sampledUndecryptable: true,
    }
  }

  if (sawDecryptableRow) {
    return {
      outcome: 'decryptable',
      sampledDecryptable: true,
      sampledUndecryptable: false,
    }
  }

  return {
    outcome: 'no_sample',
    sampledDecryptable: false,
    sampledUndecryptable: false,
  }
}
