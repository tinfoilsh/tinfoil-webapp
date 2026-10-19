import {
  deriveCodeExecutionContainerAuthToken,
  deriveCodeExecutionEncryptionKey,
} from '@/services/exec-snapshot/key-derivation'
import { describe, expect, it } from 'vitest'

// These tests guard the domain-separation invariant: same IKM (chat KEK)
// must produce independent outputs across (a) the two derivations and
// (b) different chat IDs. HKDF determinism + IKM-sensitivity is a
// property of the standard library and isn't tested here.
const CHAT_KEK_FIXTURE = new Uint8Array(32).map((_, i) => i + 1)

describe('exec-snapshot/key-derivation domain separation', () => {
  it('encryption key and container auth token are distinct for the same chat KEK', async () => {
    const exec = await deriveCodeExecutionEncryptionKey(CHAT_KEK_FIXTURE)
    const token = await deriveCodeExecutionContainerAuthToken(
      CHAT_KEK_FIXTURE,
      'chat_abc_123',
    )
    expect(Array.from(exec)).not.toEqual(Array.from(token))
  })

  it('container auth token is distinct across chat IDs', async () => {
    const a = await deriveCodeExecutionContainerAuthToken(
      CHAT_KEK_FIXTURE,
      'chat_abc_123',
    )
    const b = await deriveCodeExecutionContainerAuthToken(
      CHAT_KEK_FIXTURE,
      'chat_xyz_456',
    )
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})
