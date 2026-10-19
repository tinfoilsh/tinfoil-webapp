import { passkeyKeyManager } from '@/services/passkey/kit'
import { tinfoilWrappedKeyBundleToEnclave } from '@/services/passkey/passkey-key-storage'
import { registerKey } from '@/services/sync-enclave/sync-api'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock(
  '@/services/sync-enclave/sync-enclave-client',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/services/sync-enclave/sync-enclave-client')
      >()
    return {
      ...original,
      getSyncEnclaveClient: vi.fn(async () => ({ post: mocks.post })),
    }
  },
)

it('sends passkey-kit output through the enclave register wire unchanged', async () => {
  const credentialId = 'AQID'
  const prfResult = {
    output: Uint8Array.from({ length: 32 }, (_, index) => index),
  }
  const primary = await passkeyKeyManager.wrapKeyWithPRFResult({
    keyMaterial: new Uint8Array(32).fill(0x11),
    credentialId,
    prfResult,
  })
  const alternative = await passkeyKeyManager.wrapKeyWithPRFResult({
    keyMaterial: new Uint8Array(32).fill(0x22),
    credentialId,
    prfResult,
  })
  const bundle = tinfoilWrappedKeyBundleToEnclave({
    primary,
    alternatives: [alternative],
  })
  mocks.post.mockResolvedValueOnce({ ok: true, key_id: 'aa'.repeat(16) })

  await registerKey({
    keyB64: 'ERERERERERERERERERERERERERERERERERERERERERE=',
    ifMatch: '*',
    createdVia: 'passkey',
    idempotencyKey: 'integration-test',
    initialBundle: bundle,
  })

  expect(bundle.encryptedKeysHex).toBe(primary.wrappedKeyHex)
  expect(bundle.encryptedKeysHex).toMatch(/^[0-9a-f]{96}$/)
  expect(mocks.post).toHaveBeenCalledWith('/v1/key/register', {
    key: 'ERERERERERERERERERERERERERERERERERERERERERE=',
    if_match: '*',
    created_via: 'passkey',
    idempotency_key: 'integration-test',
    initial_bundle: {
      credential_id: credentialId,
      kek_iv: primary.kekIvHex,
      encrypted_keys: primary.wrappedKeyHex,
    },
  })
})
