import { BrokerClient } from '@/services/computer-use/broker-client'
import {
  forgetPairing,
  getStoredConnection,
  pairAndConnect,
} from '@/services/computer-use/connection'
import {
  clearRefreshCredential,
  getRefreshCredential,
  isPaired,
  setRefreshCredential,
} from '@/services/computer-use/credential-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => clearRefreshCredential())
afterEach(() => clearRefreshCredential())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('credential-store', () => {
  it('round-trips and clears the refresh credential', () => {
    expect(isPaired()).toBe(false)
    setRefreshCredential('secret')
    expect(getRefreshCredential()).toBe('secret')
    expect(isPaired()).toBe(true)
    clearRefreshCredential()
    expect(isPaired()).toBe(false)
  })
})

describe('getStoredConnection', () => {
  it('returns null when not paired', () => {
    expect(getStoredConnection()).toBeNull()
  })

  it('returns a token-managed connection when paired', () => {
    setRefreshCredential('refresh-x')
    const conn = getStoredConnection({
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(conn).not.toBeNull()
    expect(conn!.client).toBeDefined()
    expect(conn!.tokens).toBeDefined()
  })
})

describe('pairAndConnect', () => {
  it('pairs, stores the credential, and returns a connection', async () => {
    let poll = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/pair/status')) {
        return poll++ === 0
          ? jsonResponse({ state: 'pending' })
          : jsonResponse({
              state: 'approved',
              refresh_credential: 'fresh-cred',
            })
      }
      if (url.endsWith('/pair'))
        return jsonResponse({ pairing_id: 'p1', code: 'WXYZ' })
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const client = new BrokerClient({ fetchImpl })
    const onCode = vi.fn()
    const conn = await pairAndConnect(client, {
      code: 'WXYZ',
      pollIntervalMs: 1,
      onCode,
      fetchImpl,
    })

    expect(onCode).toHaveBeenCalledWith('WXYZ')
    expect(getRefreshCredential()).toBe('fresh-cred')
    expect(conn.client).toBeDefined()
  })
})

describe('forgetPairing', () => {
  it('clears the stored credential', () => {
    setRefreshCredential('x')
    forgetPairing()
    expect(isPaired()).toBe(false)
  })
})
