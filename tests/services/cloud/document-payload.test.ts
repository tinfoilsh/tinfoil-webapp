import type { Attachment } from '@/components/chat/types'
import {
  decodeDocumentPayload,
  DocumentPayloadDecodeError,
  encodeDocumentPayload,
  hasInlineDocumentPayload,
  isOffloadedDocument,
  stripDocumentPayload,
} from '@/services/cloud/document-payload'
import { describe, expect, it } from 'vitest'

const scanned: Attachment = {
  id: 'doc-1',
  type: 'document',
  fileName: 'scan.pdf',
  mimeType: 'application/pdf',
  fileSize: 12,
  textContent: 'page one text',
  pages: [{ page: 1, text: 'page one text', image: 'AQID', is_scanned: true }],
}

describe('document payload codec', () => {
  it('round-trips text and pages and leaves metadata in the chat', () => {
    const bytes = encodeDocumentPayload(scanned)
    const stripped = stripDocumentPayload(scanned)

    expect(stripped).toEqual({
      id: 'doc-1',
      type: 'document',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      fileSize: 12,
    })
    expect(decodeDocumentPayload('doc-1', bytes)).toEqual({
      textContent: 'page one text',
      pages: scanned.pages,
    })
  })

  it('classifies inline, offloaded, and image attachments', () => {
    expect(hasInlineDocumentPayload(scanned)).toBe(true)
    expect(isOffloadedDocument(scanned)).toBe(false)

    const offloaded = { ...stripDocumentPayload(scanned), encryptionKey: 'k' }
    expect(hasInlineDocumentPayload(offloaded)).toBe(false)
    expect(isOffloadedDocument(offloaded)).toBe(true)

    const image: Attachment = {
      id: 'img',
      type: 'image',
      fileName: 'a.png',
      encryptionKey: 'k',
    }
    expect(hasInlineDocumentPayload(image)).toBe(false)
    expect(isOffloadedDocument(image)).toBe(false)
  })

  it('rejects payloads that are not a document object', () => {
    const encoder = new TextEncoder()
    for (const bad of ['not json', '[]', '{"textContent":5}', '{"pages":{}}']) {
      expect(() => decodeDocumentPayload('doc-1', encoder.encode(bad))).toThrow(
        DocumentPayloadDecodeError,
      )
    }
  })
})
