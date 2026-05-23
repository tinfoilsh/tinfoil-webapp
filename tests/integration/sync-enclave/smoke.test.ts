/**
 * Live sync-enclave smoke test.
 *
 * Gated on `SYNC_ENCLAVE_URL` + `SYNC_ENCLAVE_TEST_JWT`. The test
 * builds a fresh per-run CEK, registers it through `registerKey`,
 * round-trips a profile blob through push/pull, drains the migration
 * loop once (must be a no-op for a fresh user), and cleans up. Every
 * call is attested by the same SecureClient the production app uses;
 * a failure here means the refactor's wire contract no longer matches
 * the enclave.
 *
 * Skipped automatically in local dev — `npm run test:unit` excludes
 * `tests/integration/**` so contributors without staging credentials
 * never accidentally hit the network.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The sync-enclave client captures its URL at module-load time from
// `@/config`'s `SYNC_ENCLAVE_URL`. `vi.hoisted` runs the env wiring
// BEFORE the static imports below resolve, so the client picks up
// the integration URL on first import. Without this, the static
// imports would resolve against the default URL and `resetSyncEnclaveClient`
// alone would not re-read config.
const { TEST_JWT, enabled } = vi.hoisted(() => {
  const url = process.env.SYNC_ENCLAVE_URL
  const jwt = process.env.SYNC_ENCLAVE_TEST_JWT
  const on = Boolean(url && jwt)
  if (on) {
    process.env.NEXT_PUBLIC_SYNC_ENCLAVE_URL = url
  }
  return { TEST_JWT: jwt, enabled: on }
})

import {
  bytesToBase64,
  health,
  keyCurrent,
  newIdempotencyKey,
  pull,
  push,
  registerKey,
  removeBundle,
} from '@/services/sync-enclave/sync-api'
import {
  resetSyncEnclaveClient,
  SyncEnclaveError,
} from '@/services/sync-enclave/sync-enclave-client'

function randomCekBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe.skipIf(!enabled)('sync-enclave live smoke', () => {
  let cekBytes: Uint8Array
  let cekB64: string
  let registeredKeyId: string | null = null
  const credentialId = `integration-cred-${Date.now()}`
  const profilePayload = new TextEncoder().encode(
    JSON.stringify({ smoke: true, ts: Date.now() }),
  )

  beforeAll(async () => {
    if (!enabled) return
    // The enclave client pulls the JWT from authTokenManager; for a
    // standalone integration run we override with the CI-provided
    // token without touching production auth wiring.
    const auth = await import('@/services/auth')
    auth.authTokenManager.getValidToken = async () => TEST_JWT as string
    auth.authTokenManager.getAuthHeaders = async () => ({
      Authorization: `Bearer ${TEST_JWT as string}`,
    })
    resetSyncEnclaveClient()

    cekBytes = randomCekBytes()
    cekB64 = bytesToBase64(cekBytes)
  })

  afterAll(async () => {
    if (!enabled) return
    // Best-effort cleanup. The enclave is the source of truth, so a
    // leftover key wastes nothing but it does muddy subsequent runs.
    if (registeredKeyId) {
      try {
        await removeBundle({
          keyId: registeredKeyId,
          keyB64: cekB64,
          credentialId,
          idempotencyKey: newIdempotencyKey(),
        })
      } catch (err) {
        if (!(err instanceof SyncEnclaveError)) throw err
      }
    }
  })

  it('reports a healthy enclave', async () => {
    const resp = await health()
    expect(resp.status).toBeTruthy()
  })

  it('registers a fresh key + initial bundle', async () => {
    const before = await keyCurrent()
    const resp = await registerKey({
      keyB64: cekB64,
      ifMatch: before.key_id ? (before.etag ?? '') : '*',
      createdVia: before.key_id ? 'start_fresh' : 'passkey',
      idempotencyKey: newIdempotencyKey(),
      initialBundle: {
        credentialId,
        kekIvHex: '00'.repeat(12),
        encryptedKeysHex: '00'.repeat(48),
      },
    })
    expect(resp.ok).toBe(true)
    expect(resp.key_id).toMatch(/^[0-9a-f]+$/)
    registeredKeyId = resp.key_id
  })

  it('round-trips a profile blob through push and pull', async () => {
    const pushResp = await push({
      scope: 'profile',
      id: 'profile',
      keyB64: cekB64,
      plaintext: profilePayload,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
    })
    expect(pushResp.ok).toBe(true)
    expect(pushResp.etag).toBeTruthy()
    expect(pushResp.key_id).toBe(registeredKeyId)

    const pullResp = await pull({
      scope: 'profile',
      keys: [{ key: cekB64 }],
      all: true,
    })
    expect(pullResp.items.length).toBeGreaterThanOrEqual(1)
    const ours = pullResp.items.find((i) => i.ok && i.plaintext)
    expect(ours).toBeDefined()
    if (ours?.plaintext) {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(ours.plaintext), (c) => c.charCodeAt(0)),
      )
      expect(decoded).toContain('"smoke":true')
    }
  })

  it('runs migration as a no-op for a freshly-keyed scope', async () => {
    // Just one batch is enough — the goal is to assert that the wire
    // contract is healthy. The full client loop is unit-tested in
    // legacy-blob-migration.test.ts.
    const mod = await import('@/services/sync-enclave/sync-api')
    const resp = await mod.migrate({
      scope: 'profile',
      keys: [{ key: cekB64 }],
      target: { key: cekB64 },
      limit: 1,
    })
    expect(resp.retryable_remaining).toBe(0)
    expect(resp.blocked.length).toBe(0)
  })

  it('keyCurrent reflects the registered bundle', async () => {
    const resp = await keyCurrent()
    expect(resp.key_id).toBe(registeredKeyId)
    expect(resp.bundles[credentialId]).toBeDefined()
  })
})
