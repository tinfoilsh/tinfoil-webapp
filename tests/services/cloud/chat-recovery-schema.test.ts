import { RemoteChatPlaintextSchema } from '@/services/cloud/schemas'
import { MAX_RECOVERY_CIPHERTEXT_BYTES } from '@/types/chat-recovery'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { describe, expect, it } from 'vitest'

function envelope(ciphertextBytes: number) {
  return {
    v: 1,
    turnId: 'turn-1',
    keyId: '00'.repeat(16),
    createdAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2026-07-21T00:00:00.000Z',
    nonce: uint8ArrayToBase64(new Uint8Array(12)),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertextBytes)),
  }
}

function chatWithEnvelope(recovery: ReturnType<typeof envelope>) {
  return {
    messages: [],
    pendingRecoveries: [recovery],
  }
}

describe('remote chat recovery schema', () => {
  it('accepts ciphertext within the authenticated payload bounds', () => {
    expect(
      RemoteChatPlaintextSchema.safeParse(chatWithEnvelope(envelope(17)))
        .success,
    ).toBe(true)
  })

  it('rejects ciphertext that contains only an authentication tag', () => {
    expect(
      RemoteChatPlaintextSchema.safeParse(chatWithEnvelope(envelope(16)))
        .success,
    ).toBe(false)
  })

  it('rejects ciphertext larger than the decoded byte limit', () => {
    expect(
      RemoteChatPlaintextSchema.safeParse(
        chatWithEnvelope(envelope(MAX_RECOVERY_CIPHERTEXT_BYTES + 1)),
      ).success,
    ).toBe(false)
  })

  it('rejects multiple recovery envelopes for the same turn', () => {
    const recovery = envelope(17)

    expect(
      RemoteChatPlaintextSchema.safeParse({
        messages: [],
        pendingRecoveries: [
          recovery,
          { ...recovery, ciphertext: uint8ArrayToBase64(new Uint8Array(18)) },
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects the device-local recovery discriminator', () => {
    expect(
      RemoteChatPlaintextSchema.safeParse(
        chatWithEnvelope({
          ...envelope(17),
          storage: 'local',
          sessionId: '0123456789abcdef0123456789abcdef',
          recoveryToken: 'local-token',
        }),
      ).success,
    ).toBe(false)
  })
})
