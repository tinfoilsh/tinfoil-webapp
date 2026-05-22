// @vitest-environment node
//
// Node env (not happy-dom): happy-dom enforces browser same-origin/CORS on
// fetch, which would block the loopback request before it leaves the test. The
// real CORS gate we care about is the broker's, exercised via the injected
// Origin header below.
/**
 * Bridge E2E — runs my real `BrokerClient` against a REAL `tinfoil-broker`.
 * Proves the auth/pairing bridge end-to-end (status → pair → token + negative
 * auth checks) without booting a VM (`/begin` onward is the full-slice path).
 *
 * Gated: skipped unless BROKER_E2E=1, so normal test runs don't reach for
 * localhost. Run it with the broker up in auto-approve mode:
 *
 *   ./tinfoil-broker up --auto-approve --origin http://localhost:3000
 *   BROKER_E2E=1 npx vitest run tests/services/computer-use/e2e.bridge.test.ts
 *
 * The browser normally sets `Origin` automatically; here we inject it (Node lets
 * us) so the broker's exact-origin CORS gate is exercised authentically.
 */

import { createBrokerConnection } from '@/services/computer-use/access-token'
import { BrokerClient } from '@/services/computer-use/broker-client'
import { runPairing } from '@/services/computer-use/pairing'
import { BrokerError } from '@/services/computer-use/types'
import { describe, expect, it } from 'vitest'

const RUN = process.env.BROKER_E2E === '1'
const ORIGIN = process.env.BROKER_E2E_ORIGIN ?? 'http://127.0.0.1:3000'
const BASE = process.env.BROKER_E2E_BASE ?? 'http://127.0.0.1:8765'

/** A fetch that injects the given Origin (browsers set this; Node doesn't). */
function originFetch(origin: string): typeof fetch {
  return ((input: any, init: any = {}) => {
    const headers = new Headers(init.headers as HeadersInit | undefined)
    headers.set('Origin', origin)
    return fetch(input, { ...init, headers })
  }) as typeof fetch
}

const d = RUN ? describe : describe.skip

d('bridge E2E (real broker)', () => {
  const fetchImpl = originFetch(ORIGIN)

  it('GET /status reports a running daemon', async () => {
    const client = new BrokerClient({ baseUrl: BASE, fetchImpl })
    const status = await client.getStatus()
    expect(status.running).toBe(true)
    // Helpful context for the full-slice run.
    console.log(
      'broker images:',
      status.images.map((i) => `${i.name}(${i.ready ? 'ready' : 'not-ready'})`),
    )
  })

  it('pairs (auto-approve) and mints an access token', async () => {
    const client = new BrokerClient({ baseUrl: BASE, fetchImpl })
    const { refreshCredential } = await runPairing(client, {
      pollIntervalMs: 300,
      timeoutMs: 15_000,
    })
    expect(refreshCredential.length).toBeGreaterThan(10)

    const { tokens } = createBrokerConnection({
      refreshCredential,
      baseUrl: BASE,
      fetchImpl,
    })
    const jwt = await tokens.getAccessToken()
    // HS256 JWT: three dot-separated segments.
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('rejects a foreign origin with 403', async () => {
    const client = new BrokerClient({
      baseUrl: BASE,
      fetchImpl: originFetch('https://evil.example'),
    })
    await expect(client.getStatus()).rejects.toSatisfy(
      (e: unknown) => e instanceof BrokerError && e.status === 403,
    )
  })

  it('rejects a bogus refresh credential with 401', async () => {
    const client = new BrokerClient({ baseUrl: BASE, fetchImpl })
    await expect(
      client.mintAccessToken('not-a-real-credential'),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof BrokerError && e.status === 401,
    )
  })
})
