import { BrokerClient } from '@/services/computer-use/broker-client'
import {
  PairingDeniedError,
  generatePairingCode,
  runPairing,
} from '@/services/computer-use/pairing'
import type { PairState } from '@/services/computer-use/types'
import { describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Drive /pair once, then walk /pair/status through a scripted state sequence. */
function scriptedFetch(
  states: Array<{ state: PairState; refresh_credential?: string }>,
) {
  let poll = 0
  return vi.fn(async (url: string) => {
    if (url.includes('/pair/status')) {
      return jsonResponse(states[Math.min(poll++, states.length - 1)])
    }
    if (url.endsWith('/pair')) {
      return jsonResponse({ pairing_id: 'pid_1', code: 'AB23' })
    }
    throw new Error(`unexpected url ${url}`)
  }) as unknown as typeof fetch
}

describe('generatePairingCode', () => {
  it('produces an unambiguous fixed-length code', () => {
    const code = generatePairingCode(4)
    expect(code).toHaveLength(4)
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)
  })
})

describe('runPairing', () => {
  it('returns the refresh credential once approved', async () => {
    const fetchImpl = scriptedFetch([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'approved', refresh_credential: 'secret-refresh' },
    ])
    const client = new BrokerClient({ fetchImpl })
    const states: PairState[] = []

    const result = await runPairing(client, {
      code: 'AB23',
      pollIntervalMs: 1,
      onState: (s) => states.push(s),
    })

    expect(result.refreshCredential).toBe('secret-refresh')
    expect(result.code).toBe('AB23')
    expect(states).toContain('pending')
    expect(states).toContain('approved')
  })

  it('rejects when the tray denies', async () => {
    const fetchImpl = scriptedFetch([{ state: 'pending' }, { state: 'denied' }])
    const client = new BrokerClient({ fetchImpl })

    await expect(
      runPairing(client, { pollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(PairingDeniedError)
  })

  it('uses a caller-supplied code and surfaces it via onCode', async () => {
    const fetchImpl = scriptedFetch([
      { state: 'approved', refresh_credential: 'r' },
    ])
    const client = new BrokerClient({ fetchImpl })
    const onCode = vi.fn()

    const result = await runPairing(client, {
      code: 'WXYZ',
      pollIntervalMs: 1,
      onCode,
    })
    expect(result.code).toBe('WXYZ')
    expect(onCode).toHaveBeenCalledWith('WXYZ')
  })
})
