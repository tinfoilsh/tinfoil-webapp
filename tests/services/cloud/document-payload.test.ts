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

  // The document enclave encodes pages with Go's `omitempty`, so a scanned
  // or blank page has no `text` key and a page whose render failed has no
  // `image` key. This is the literal shape of a `?mode=images` response
  // for a two-page PDF whose second page is a scan.
  it('accepts the enclave response shape with omitted empty fields', () => {
    const enclaveResponse = {
      textContent: 'Cover letter\n\n---\n\n',
      pages: [
        { page: 1, text: 'Cover letter', image: 'AQID', is_scanned: false },
        { page: 2, image: 'BAUG', is_scanned: true },
        { page: 3, is_scanned: true },
      ],
    }
    expect(
      decodeDocumentPayload(
        'doc-1',
        new TextEncoder().encode(JSON.stringify(enclaveResponse)),
      ),
    ).toEqual({
      textContent: 'Cover letter\n\n---\n\n',
      pages: [
        { page: 1, text: 'Cover letter', image: 'AQID', is_scanned: false },
        { page: 2, text: '', image: 'BAUG', is_scanned: true },
        { page: 3, text: '', image: '', is_scanned: true },
      ],
    })
  })

  it.each([
    {},
    { pages: [null] },
    { pages: ['page'] },
    { pages: [{ page: 1 }] },
    { pages: [{ page: 1, text: {}, image: '', is_scanned: false }] },
    { pages: [{ page: 1, text: null, image: '', is_scanned: false }] },
    { pages: [{ page: 1, text: '', image: 4, is_scanned: false }] },
    { pages: [{ page: 1, text: '', image: null, is_scanned: false }] },
    { pages: [{ page: 1, text: '', image: '', is_scanned: 'false' }] },
    { pages: [{ page: -1, text: 'text', image: '', is_scanned: false }] },
    { pages: [{ page: 0.5, text: 'text', image: '', is_scanned: false }] },
    { pages: [{ page: 1, text: 'text', image: '' }] },
  ])('rejects missing content or malformed pages: %j', (payload) => {
    expect(() =>
      decodeDocumentPayload(
        'doc-1',
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
    ).toThrow(DocumentPayloadDecodeError)
  })

  it('names the failing field in the decode error', () => {
    const payload = {
      pages: [{ page: 1, text: 'x', image: '', is_scanned: 'no' }],
    }
    expect(() =>
      decodeDocumentPayload(
        'doc-1',
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
    ).toThrow(/pages\.0\.is_scanned/)
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
