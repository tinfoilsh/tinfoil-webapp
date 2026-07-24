import { RemoteChatPlaintextSchema } from '@/services/cloud/schemas'
import {
  decryptRecoveryEnvelope,
  encryptRecoveryEnvelope,
  rewrapRecoveryEnvelope,
  validateRecoveryEnvelope,
  type RecoveryTokenFields,
} from '@/services/inference/chat-recovery-crypto'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { describe, expect, it } from 'vitest'

const USER_ID = 'user_123'
const CHAT_ID = 'chat_123'
const TURN_ID = 'turn_123'
const SESSION_ID = '0123456789abcdef0123456789abcdef'
const NOW = Date.parse('2026-07-20T12:00:00.000Z')
const TOKEN: RecoveryTokenFields = {
  exportedSecret: 'a'.repeat(64),
  requestEnc: 'b'.repeat(64),
}

function cek(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

async function envelope() {
  return encryptRecoveryEnvelope({
    cek: cek(1),
    userId: USER_ID,
    chatId: CHAT_ID,
    turnId: TURN_ID,
    sessionId: SESSION_ID,
    recoveryToken: TOKEN,
    now: NOW,
  })
}

describe('chat recovery envelope crypto', () => {
  it('round-trips a recovery payload', async () => {
    const encrypted = await envelope()

    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: encrypted,
        now: NOW,
      }),
    ).resolves.toEqual({
      sessionId: SESSION_ID,
      recoveryToken: TOKEN,
    })
  })

  it('round-trips an SDK-serialized recovery token', async () => {
    const recoveryToken = JSON.stringify(TOKEN)
    const encrypted = await encryptRecoveryEnvelope({
      cek: cek(1),
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      recoveryToken,
      now: NOW,
    })

    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: encrypted,
        now: NOW,
      }),
    ).resolves.toEqual({ sessionId: SESSION_ID, recoveryToken })
  })

  it('rejects the wrong CEK and AAD', async () => {
    const encrypted = await envelope()

    await expect(
      decryptRecoveryEnvelope({
        cek: cek(2),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: encrypted,
        now: NOW,
      }),
    ).rejects.toThrow()
    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: 'another-user',
        chatId: CHAT_ID,
        envelope: encrypted,
        now: NOW,
      }),
    ).rejects.toThrow()
  })

  it('rejects ciphertext and authenticated metadata tampering', async () => {
    const encrypted = await envelope()
    const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (value) =>
      value.charCodeAt(0),
    )
    ciphertext[0] ^= 1

    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: {
          ...encrypted,
          ciphertext: uint8ArrayToBase64(ciphertext),
        },
        now: NOW,
      }),
    ).rejects.toThrow()
    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: { ...encrypted, turnId: 'tampered-turn' },
        now: NOW,
      }),
    ).rejects.toThrow()
  })

  it('rejects expired and malformed envelopes and payload inputs', async () => {
    const encrypted = await envelope()

    await expect(
      decryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: encrypted,
        now: Date.parse(encrypted.expiresAt),
      }),
    ).rejects.toThrow('expired')

    expect(() =>
      validateRecoveryEnvelope({ ...encrypted, nonce: 'not-base64' }),
    ).toThrow()
    await expect(
      encryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        sessionId: SESSION_ID.toUpperCase(),
        recoveryToken: TOKEN,
        now: NOW,
      }),
    ).rejects.toThrow('sessionId')
    await expect(
      encryptRecoveryEnvelope({
        cek: cek(1),
        userId: USER_ID,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        recoveryToken: { ...TOKEN, requestEnc: 'ab' },
        now: NOW,
      }),
    ).rejects.toThrow('requestEnc')
  })

  it('rewraps under a new CEK without changing recovery metadata', async () => {
    const encrypted = await envelope()
    const rewrapped = await rewrapRecoveryEnvelope({
      envelope: encrypted,
      userId: USER_ID,
      chatId: CHAT_ID,
      oldCek: cek(1),
      newCek: cek(2),
      now: NOW,
    })

    expect(rewrapped.keyId).not.toBe(encrypted.keyId)
    expect(rewrapped.createdAt).toBe(encrypted.createdAt)
    expect(rewrapped.expiresAt).toBe(encrypted.expiresAt)
    await expect(
      decryptRecoveryEnvelope({
        cek: cek(2),
        userId: USER_ID,
        chatId: CHAT_ID,
        envelope: rewrapped,
        now: NOW,
      }),
    ).resolves.toEqual({
      sessionId: SESSION_ID,
      recoveryToken: TOKEN,
    })
  })

  it('validates turn IDs and pending recoveries in remote chat plaintext', async () => {
    const encrypted = await envelope()
    expect(
      RemoteChatPlaintextSchema.safeParse({
        messages: [{ role: 'user', content: 'hello', turnId: TURN_ID }],
        pendingRecoveries: [encrypted],
      }).success,
    ).toBe(true)
    expect(
      RemoteChatPlaintextSchema.safeParse({
        messages: [{ role: 'user', content: 'hello', turnId: '' }],
        pendingRecoveries: [encrypted],
      }).success,
    ).toBe(false)
    expect(
      RemoteChatPlaintextSchema.safeParse({
        messages: [],
        pendingRecoveries: [{ ...encrypted, keyId: 'invalid' }],
      }).success,
    ).toBe(false)
  })
})
