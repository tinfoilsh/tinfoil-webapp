import { hydrateProjectDocuments } from '@/components/project/project-document-hydration'
import type { ProjectDocument } from '@/types/project'
import { describe, expect, it } from 'vitest'

const listedDocument = {
  id: 'doc-1',
  projectId: 'project-1',
  sizeBytes: 0,
  syncVersion: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

function fullDocument(
  overrides: Partial<ProjectDocument> = {},
): ProjectDocument {
  return {
    ...listedDocument,
    filename: 'notes.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4096,
    content: 'Persisted project context',
    ...overrides,
  }
}

describe('hydrateProjectDocuments', () => {
  it('uses the persisted document size instead of list metadata', () => {
    const hydrated = hydrateProjectDocuments(
      [listedDocument],
      new Map([['doc-1', fullDocument()]]),
    )

    expect(hydrated[0]).toMatchObject({
      filename: 'notes.pdf',
      sizeBytes: 4096,
      content: 'Persisted project context',
    })
  })

  it('preserves loaded content when a refresh cannot decrypt the document', () => {
    const previous = fullDocument()
    const unavailable = fullDocument({
      filename: '',
      contentType: '',
      sizeBytes: 0,
      content: undefined,
      decryptionFailed: true,
    })

    const hydrated = hydrateProjectDocuments(
      [listedDocument],
      new Map([['doc-1', unavailable]]),
      [previous],
    )

    expect(hydrated[0]).toMatchObject({
      filename: 'notes.pdf',
      sizeBytes: 4096,
      content: 'Persisted project context',
    })
    expect(hydrated[0].decryptionFailed).toBeFalsy()
  })

  it('preserves valid empty legacy documents during a failed refresh', () => {
    const previous = fullDocument({ content: '', sizeBytes: 128 })

    const hydrated = hydrateProjectDocuments([listedDocument], new Map(), [
      previous,
    ])

    expect(hydrated[0]).toMatchObject({
      filename: 'notes.pdf',
      sizeBytes: 128,
      content: '',
    })
  })

  it('marks an unavailable document instead of presenting it as empty', () => {
    const hydrated = hydrateProjectDocuments([listedDocument], new Map())

    expect(hydrated[0]).toMatchObject({
      filename: '',
      sizeBytes: 0,
      decryptionFailed: true,
    })
  })
})
