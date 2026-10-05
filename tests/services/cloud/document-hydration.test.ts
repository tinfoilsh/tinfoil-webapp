import type { Message } from '@/components/chat/types'
import {
  DocumentHydrationError,
  hydrateDocumentAttachments,
} from '@/services/cloud/document-hydration'
import { DocumentPayloadDecodeError } from '@/services/cloud/document-payload'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/sync-enclave/sync-api', () => ({
  attachmentGet: vi.fn(),
}))

function messageWithPages(pages: unknown): Message {
  return {
    role: 'user',
    content: 'Summarize this',
    timestamp: new Date(0),
    attachments: [
      {
        id: 'doc-1',
        type: 'document',
        fileName: 'contract.pdf',
        // Deliberately untyped: the test feeds shapes the enclave and
        // older clients actually produce, not what the type promises.
        pages: pages as DocumentPage[],
      },
    ],
  }
}

describe('hydrateDocumentAttachments', () => {
  it('passes through a scanned PDF exactly as the enclave returns it', async () => {
    const [hydrated] = await hydrateDocumentAttachments([
      messageWithPages([
        { page: 1, text: 'Intro', image: 'AQID', is_scanned: false },
        { page: 2, image: 'BAUG', is_scanned: true },
      ]),
    ])

    expect(hydrated.attachments![0].pages).toEqual([
      { page: 1, text: 'Intro', image: 'AQID', is_scanned: false },
      { page: 2, text: '', image: 'BAUG', is_scanned: true },
    ])
  })

  it('names the file and asks for a re-attach when stored pages are malformed', async () => {
    const promise = hydrateDocumentAttachments([
      messageWithPages([{ page: 'one', text: 'Intro', is_scanned: false }]),
    ])

    await expect(promise).rejects.toBeInstanceOf(DocumentHydrationError)
    await expect(promise).rejects.toMatchObject({
      reason: 'invalid',
      message: expect.stringContaining('"contract.pdf"'),
      cause: expect.any(DocumentPayloadDecodeError),
    })
  })
})
