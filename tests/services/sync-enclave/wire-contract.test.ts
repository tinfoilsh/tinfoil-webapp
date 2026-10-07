/**
 * Pin every wire-contract literal to the exact string the controlplane
 * sends on the wire. The Go source of truth is
 * github.com/tinfoilsh/controlplane/pkg/contract; if a constant changes
 * there and this file is not updated, the test below fails.
 *
 * Do not relax these assertions to "string truthy" — the point is to
 * catch typos before they reach a running server.
 */
import { CloudStorageService } from '@/services/cloud/cloud-storage'
import { encryptionService } from '@/services/encryption/encryption-service'
import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import { storeEncryptedKeys } from '@/services/passkey/passkey-key-storage'
import {
  getSyncEnclaveClient,
  resetSyncEnclaveClient,
} from '@/services/sync-enclave/sync-enclave-client'
import {
  MAX_PULL_IDS,
  PULL_ITEM_CODE_UNSPECIFIED,
  PULL_ITEM_CODES,
  SYNC_PROTOCOL_VERSION,
  WIRE_CODES,
} from '@/services/sync-enclave/wire-contract'
import { beforeEach, vi } from 'vitest'

const PRIMARY_KEY = `key_${'ar'.repeat(32)}`
const PRIMARY_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='
const { secureFetch } = vi.hoisted(() => ({
  secureFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('tinfoil', () => ({
  SecureClient: class {
    ready = vi.fn(async () => {})
    fetch = secureFetch
  },
}))
vi.mock('@/services/auth', () => ({
  authTokenManager: { getValidToken: vi.fn(async () => 'test-jwt') },
}))
function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}
beforeEach(async () => {
  resetSyncEnclaveClient()
  encryptionService.clearKey()
  await encryptionService.setKey(PRIMARY_KEY)
  secureFetch
    .mockReset()
    .mockRejectedValue(new Error('Unexpected secure request'))
})

describe('wire-contract', () => {
  it('pins the sync protocol version', () => {
    expect(SYNC_PROTOCOL_VERSION).toBe('3')
  })

  it('sends the literal controlplane protocol header on verified requests', async () => {
    secureFetch.mockResolvedValueOnce(response({ key_id: null, bundles: {} }))
    const client = await getSyncEnclaveClient()
    await client.post('/v1/key/current', {})
    expect(secureFetch).toHaveBeenCalledOnce()
    expect(
      new Headers(secureFetch.mock.calls[0][1]?.headers).get('X-Sync-Protocol'),
    ).toBe('3')
  })

  it.each([false, true])(
    'transmits restore consent only when explicitly requested: %s',
    async (restoreDeleted) => {
      secureFetch.mockResolvedValueOnce(
        response({ ok: true, etag: '8', key_id: 'key-id' }),
      )
      await new CloudStorageService().uploadChat(
        {
          id: 'chat-1',
          title: 'Test',
          messages: [],
          projectId: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          syncVersion: 7,
          lastAccessedAt: 0,
        },
        { restoreDeleted, idempotencyKey: 'restore-intent' },
      )
      expect(secureFetch).toHaveBeenCalledOnce()
      const [url, init] = secureFetch.mock.calls[0]
      expect(new URL(url).pathname).toBe('/v1/sync/push')
      const body = JSON.parse(init!.body as string)
      expect(body.key).toBe(PRIMARY_KEY_B64)
      expect(body.if_match).toBe(restoreDeleted ? null : '7')
      expect(body.metadata).toEqual(
        restoreDeleted
          ? { messageCount: 0, projectId: 'project-1', restoreDeleted: true }
          : { messageCount: 0 },
      )
    },
  )

  it.each([false, true])(
    'registers with create-only sentinel or explicit rotation ETag: %s',
    async (rotating) => {
      secureFetch
        .mockResolvedValueOnce(
          response({
            key_id: rotating ? 'ff'.repeat(16) : null,
            etag: 'remote-etag',
            bundles: {},
          }),
        )
        .mockResolvedValueOnce(response({ ok: true, key_id: 'registered-key' }))
        .mockResolvedValueOnce(
          response({
            key_id: 'registered-key',
            bundles: { AQID: { bundle_version: 1 } },
          }),
        )
      const result = await storeEncryptedKeys(
        {
          primary: {
            profile: TINFOIL_PASSKEY_PROFILE,
            credentialId: 'AQID',
            kekIvHex: '01'.repeat(12),
            wrappedKeyHex: '02'.repeat(48),
          },
          alternatives: [],
        },
        {
          primary: PRIMARY_KEY,
          alternatives: [],
          authorizationMode: rotating ? 'explicit_start_fresh' : 'validated',
        },
      )
      expect(result).toEqual({ syncVersion: 1, bundleVersion: 1 })
      expect(secureFetch).toHaveBeenCalledTimes(3)
      const [url, init] = secureFetch.mock.calls[1]
      expect(new URL(url).pathname).toBe('/v1/key/register')
      expect(JSON.parse(init!.body as string)).toEqual({
        key: PRIMARY_KEY_B64,
        if_match: rotating ? 'remote-etag' : '*',
        created_via: rotating ? 'start_fresh' : 'passkey',
        idempotency_key: expect.stringMatching(/^[0-9a-f]{32}$/),
        initial_bundle: {
          credential_id: 'AQID',
          kek_iv: '01'.repeat(12),
          encrypted_keys: '02'.repeat(48),
        },
      })
    },
  )

  it('wire codes match controlplane/pkg/contract/wirecodes.go', () => {
    expect(WIRE_CODES).toEqual({
      PreconditionRequired: 'PRECONDITION_REQUIRED',
      StaleBlob: 'STALE_BLOB',
      StaleKey: 'STALE_KEY',
      IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
      ExistingDataUnderOtherKey: 'EXISTING_DATA_UNDER_OTHER_KEY',
      SyncConflict: 'SYNC_CONFLICT',
      ProfileSyncUpgradeRequired: 'PROFILE_SYNC_UPGRADE_REQUIRED',
    })
  })

  it('pull contract matches confidential-sync internal/server', () => {
    expect(MAX_PULL_IDS).toBe(100)
    expect(PULL_ITEM_CODES).toEqual({
      NotFound: 'NOT_FOUND',
      UnknownKey: 'UNKNOWN_KEY',
      Network: 'NETWORK',
      BadRequest: 'BAD_REQUEST',
      LegacyBlobNotMigrated: 'LEGACY_BLOB_NOT_MIGRATED',
    })
    expect(PULL_ITEM_CODE_UNSPECIFIED).toBe('UNSPECIFIED')
  })
})
