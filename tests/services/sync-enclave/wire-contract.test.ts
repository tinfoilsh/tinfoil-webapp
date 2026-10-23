/**
 * Pin every wire-contract literal to the exact string sent on the wire.
 * The harness forwards key requests to the sync enclave verbatim, so the
 * sentinels must match github.com/tinfoilsh/controlplane/pkg/contract; the
 * harness translates key refusals to its own error codes.
 *
 * Do not relax these assertions to "string truthy" — the point is to
 * catch typos before they reach a running server.
 */
import { encryptionService } from '@/services/encryption/encryption-service'
import { HarnessClient } from '@/services/harness/client'
import {
  activateAPI,
  HarnessAPI,
  resetHarnessAPI,
} from '@/services/harness/runtime'
import {
  HARNESS_KEY_CODES,
  IF_MATCH_SENTINELS,
} from '@/services/keys/wire-contract'
import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import {
  PasskeyCredentialConflictError,
  storeEncryptedKeys,
} from '@/services/passkey/passkey-key-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('tinfoil', () => ({ SecureClient: vi.fn() }))

const PRIMARY_KEY = `key_${'ar'.repeat(32)}`
const PRIMARY_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='
const secureFetch =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function wrappedKeys() {
  return {
    primary: {
      profile: TINFOIL_PASSKEY_PROFILE,
      credentialId: 'AQID',
      kekIvHex: '01'.repeat(12),
      wrappedKeyHex: '02'.repeat(48),
    },
    alternatives: [],
  }
}

beforeEach(async () => {
  secureFetch
    .mockReset()
    .mockRejectedValue(new Error('Unexpected secure request'))
  encryptionService.clearKey()
  await encryptionService.setKey(PRIMARY_KEY)
  activateAPI(
    new HarnessAPI(
      new HarnessClient(
        'https://harness.example',
        async () => 'test-jwt',
        () =>
          ({
            ready: async () => {},
            fetch: secureFetch,
            getVerificationDocument: vi.fn(),
          }) as unknown as ReturnType<
            NonNullable<ConstructorParameters<typeof HarnessClient>[2]>
          >,
      ),
      'user_1',
    ),
  )
})

afterEach(() => {
  resetHarnessAPI()
  encryptionService.clearKey()
})

describe('wire-contract', () => {
  it('if-match sentinels match controlplane/pkg/contract/sentinels.go', () => {
    expect(IF_MATCH_SENTINELS).toEqual({ CreateOnly: '0', AnyKey: '*' })
  })

  it('key codes match the harness downstreamError translation', () => {
    expect(HARNESS_KEY_CODES).toEqual({ KeyMismatch: 'KEY_MISMATCH' })
  })

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
      const result = await storeEncryptedKeys(wrappedKeys(), {
        primary: PRIMARY_KEY,
        alternatives: [],
        authorizationMode: rotating ? 'explicit_start_fresh' : 'validated',
      })
      expect(result).toEqual({ syncVersion: 1, bundleVersion: 1 })
      expect(
        secureFetch.mock.calls.map(([url]) => new URL(url).pathname),
      ).toEqual(['/v1/keys/current', '/v1/keys/register', '/v1/keys/current'])
      const init = secureFetch.mock.calls[1][1]
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer test-jwt',
      )
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

  it('turns a harness key-mismatch refusal into a credential conflict', async () => {
    secureFetch
      .mockResolvedValueOnce(response({ key_id: null, bundles: {} }))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: 'KEY_MISMATCH',
              message: 'The stored data uses another content key',
            },
          },
          409,
        ),
      )
    await expect(
      storeEncryptedKeys(wrappedKeys(), {
        primary: PRIMARY_KEY,
        alternatives: [],
        authorizationMode: 'validated',
      }),
    ).rejects.toBeInstanceOf(PasskeyCredentialConflictError)
    expect(secureFetch).toHaveBeenCalledTimes(2)
    expect(new URL(secureFetch.mock.calls[1][0]).pathname).toBe(
      '/v1/keys/register',
    )
  })
})
