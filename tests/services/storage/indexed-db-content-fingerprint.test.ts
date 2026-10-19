import {
  chatContentFingerprint,
  resolveStoredLocalOnly,
  snapshotChatForStorage,
} from '@/services/storage/indexed-db'
import { describe, expect, it } from 'vitest'

describe('chatContentFingerprint', () => {
  it('ignores updatedAt differences (not part of fingerprint input)', () => {
    const first = {
      title: 'T',
      projectId: undefined,
      updatedAt: '2024-01-01T00:00:00Z',
      messages: [
        { role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:00Z' },
      ],
    }
    const second = {
      title: 'T',
      projectId: undefined,
      updatedAt: '2024-12-31T23:59:59Z',
      messages: [
        { role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:00Z' },
      ],
    }
    expect(chatContentFingerprint(first)).toBe(chatContentFingerprint(second))
  })

  it('changes when message content changes (same length)', () => {
    const fp1 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        { role: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
      ],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        { role: 'user', content: 'world', timestamp: '2024-01-01T00:00:00Z' },
      ],
    })
    expect(fp1).not.toBe(fp2)
  })

  it('changes when title changes', () => {
    const fp1 = chatContentFingerprint({
      title: 'A',
      projectId: undefined,
      messages: [],
    })
    const fp2 = chatContentFingerprint({
      title: 'B',
      projectId: undefined,
      messages: [],
    })
    expect(fp1).not.toBe(fp2)
  })

  it('changes when projectId changes', () => {
    const fp1 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      projectId: 'p1',
      messages: [],
    })
    expect(fp1).not.toBe(fp2)
  })

  it('changes when message turnId changes', () => {
    const message = {
      role: 'user',
      content: 'hello',
      timestamp: '2024-01-01T00:00:00Z',
    }
    const fp1 = chatContentFingerprint({
      title: 'T',
      messages: [{ ...message, turnId: 'turn-1' }],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      messages: [{ ...message, turnId: 'turn-2' }],
    })

    expect(fp1).not.toBe(fp2)
  })

  it('changes when only pending recovery envelopes change', () => {
    const recovery = {
      v: 1,
      turnId: 'turn-1',
      keyId: 'a'.repeat(32),
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-27T00:00:00.000Z',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
    }
    const fp1 = chatContentFingerprint({
      title: 'T',
      messages: [],
      pendingRecoveries: [recovery],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      messages: [],
      pendingRecoveries: [
        { ...recovery, ciphertext: 'AQAAAAAAAAAAAAAAAAAAAA==' },
      ],
    })

    expect(fp1).not.toBe(fp2)
  })

  it('does not depend on full documentContent string (hashes it)', () => {
    const fp1 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        {
          role: 'user',
          content: 'x',
          timestamp: '2024-01-01T00:00:00Z',
          documentContent: 'A'.repeat(10_000),
        },
      ],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        {
          role: 'user',
          content: 'x',
          timestamp: '2024-01-01T00:00:00Z',
          documentContent: 'A'.repeat(9_999) + 'B',
        },
      ],
    })
    expect(fp1).not.toBe(fp2)
  })

  it('captures equal-length legacy image payload changes', () => {
    const fp1 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        {
          role: 'user',
          content: 'x',
          timestamp: '2024-01-01T00:00:00Z',
          imageData: [{ mimeType: 'image/png', base64: 'AAA' }],
        },
      ],
    })
    const fp2 = chatContentFingerprint({
      title: 'T',
      projectId: undefined,
      messages: [
        {
          role: 'user',
          content: 'x',
          timestamp: '2024-01-01T00:00:00Z',
          imageData: [{ mimeType: 'image/png', base64: 'BBB' }],
        },
      ],
    })
    expect(fp1).not.toBe(fp2)
  })

  it('uses collision-resistant SHA-256 attachment hashes', () => {
    const attachment = {
      id: 'attachment',
      type: 'image',
      fileName: 'image.png',
    }
    const fingerprint = (base64: string) =>
      chatContentFingerprint({
        title: 'T',
        messages: [
          {
            role: 'user',
            content: 'x',
            timestamp: '2024-01-01T00:00:00Z',
            attachments: [{ ...attachment, base64 }],
          },
        ],
      })

    const knownHash = JSON.parse(fingerprint('AAA')).messages[0].attachments[0]
      .base64Hash
    expect(knownHash).toBe(
      'cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358',
    )
    expect(fingerprint('up/Gwn25')).not.toBe(fingerprint('XND8FyWq'))
    expect(fingerprint('AAA')).not.toBe(fingerprint('BBB'))
  })
})

describe('snapshotChatForStorage', () => {
  it('copies mutable containers without serializing attachment payloads', () => {
    const base64 = 'A'.repeat(10_000)
    const chat = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      messages: [
        {
          role: 'user' as const,
          content: 'hello',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
          attachments: [
            {
              id: 'attachment-1',
              type: 'document' as const,
              fileName: 'document.pdf',
              base64,
              pages: [
                { page: 1, text: 'page', image: base64, is_scanned: true },
              ],
            },
          ],
        },
      ],
    }

    const snapshot = snapshotChatForStorage(chat)
    chat.messages[0].attachments[0].pages[0].text = 'changed'

    expect(snapshot.messages[0].attachments?.[0].pages?.[0].text).toBe('page')
    expect(snapshot.messages[0].attachments?.[0].base64).toBe(base64)
  })
})

describe('resolveStoredLocalOnly', () => {
  it('preserves explicit local-only storage without deriving it from sync state', () => {
    expect(resolveStoredLocalOnly(false, true)).toBe(true)
    expect(resolveStoredLocalOnly(true, false)).toBe(true)
    expect(resolveStoredLocalOnly(false, false)).toBe(false)
    expect(resolveStoredLocalOnly(false, true, true)).toBe(false)
  })
})
