import { describe, expect, it } from 'vitest'

import { processRemoteChat } from '@/services/cloud/chat-codec'
import { chatHealth } from '@/services/cloud/chat-health'
import type { StoredChat } from '@/services/storage/indexed-db'

function baseChat(overrides: Partial<StoredChat> = {}): StoredChat {
  return {
    id: 'chat-1',
    title: 'Title',
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: 0,
    syncedAt: 0,
    locallyModified: false,
    syncVersion: 1,
    ...overrides,
  } as StoredChat
}

describe('chatHealth', () => {
  it('returns HEALTHY for a normal chat', () => {
    expect(chatHealth(baseChat())).toBe('HEALTHY')
  })

  it('returns LOST when dataCorrupted is true', () => {
    expect(chatHealth(baseChat({ dataCorrupted: true }))).toBe('LOST')
  })

  it('returns UNREACHABLE when only decryptionFailed is true', () => {
    expect(chatHealth(baseChat({ decryptionFailed: true }))).toBe('UNREACHABLE')
  })

  it('LOST wins over UNREACHABLE when both flags are set', () => {
    expect(
      chatHealth(baseChat({ dataCorrupted: true, decryptionFailed: true })),
    ).toBe('LOST')
  })
})

describe('§9.6 R5 — v2 plaintext path never produces placeholders', () => {
  it('returns a HEALTHY chat from valid v2 plaintext', async () => {
    const plaintext = JSON.stringify({
      id: 'chat-1',
      title: 'Hello world',
      messages: [{ role: 'user', content: 'hi' }],
      syncVersion: 3,
    })
    const result = await processRemoteChat({
      id: 'chat-1',
      plaintext,
      formatVersion: 2,
    })
    expect(result.status).toBe('decrypted')
    expect(result.chat.decryptionFailed).toBeUndefined()
    expect(result.chat.dataCorrupted).toBeUndefined()
    expect(chatHealth(result.chat)).toBe('HEALTHY')
  })

  it('throws on malformed v2 plaintext instead of producing a placeholder', async () => {
    // Malformed plaintext from the enclave is a server bug, not a
    // client-side decryption failure. The new contract is the v2
    // path must throw so the caller can route the error through
    // decideRecovery and the chat list never receives a polluting
    // placeholder row.
    await expect(
      processRemoteChat({
        id: 'chat-1',
        plaintext: '{not json',
        formatVersion: 2,
      }),
    ).rejects.toThrow(/v2_plaintext_invalid/)
  })
})
