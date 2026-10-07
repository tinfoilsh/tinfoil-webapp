import {
  buildClaudeProjectExport,
  ClaudeProjectExportSizeError,
  formatClaudeProjectExportCounts,
} from '@/services/project-export/claude-project-export'
import type {
  Project,
  ProjectDocument,
  ProjectListResponse,
} from '@/types/project'
import claudeProjectsFixture from '../../fixtures/claude-projects.json'

type ExportStorage = Parameters<typeof buildClaudeProjectExport>[0]

const createdAt = '2026-01-02T03:04:05.000Z'
const updatedAt = '2026-02-03T04:05:06.000Z'

function listItem(id: string): ProjectListResponse['projects'][number] {
  return {
    id,
    key: id,
    createdAt,
    updatedAt,
    syncVersion: 1,
    size: 0,
  }
}

function project(id: string): Project {
  return {
    id,
    name: id === 'project-1' ? 'Research' : id,
    description: id === 'project-1' ? 'Source notes' : '',
    systemInstructions:
      id === 'project-1' ? 'Answer from the provided material.' : '',
    memory: [
      {
        id: 'fact-1',
        fact: 'unsupported',
        date: createdAt,
        category: 'test',
        confidence: 1,
      },
    ],
    color: '#ffffff',
    createdAt: 'ignored',
    updatedAt: 'ignored',
    syncVersion: 1,
  }
}

function storage(overrides: Partial<ExportStorage> = {}): ExportStorage {
  return {
    listProjects: vi.fn().mockResolvedValue({
      projects: [listItem('project-1')],
      hasMore: false,
    }),
    getProject: vi.fn().mockImplementation(async (id: string) => project(id)),
    listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
    getDocument: vi.fn(),
    ...overrides,
  } as ExportStorage
}

describe('buildClaudeProjectExport', () => {
  it('paginates a fresh project listing before reading projects', async () => {
    const calls: string[] = []
    const testStorage = storage({
      listProjects: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('list-1')
          return {
            projects: [listItem('project-1')],
            hasMore: true,
            nextContinuationToken: 'next',
          }
        })
        .mockImplementationOnce(async () => {
          calls.push('list-2')
          return {
            projects: [listItem('project-2')],
            hasMore: false,
          }
        }),
      getProject: vi.fn().mockImplementation(async (id: string) => {
        calls.push(`get-${id}`)
        return project(id)
      }),
    })

    const result = await buildClaudeProjectExport(testStorage)

    expect(JSON.parse(result.json)).toHaveLength(2)
    expect(testStorage.listProjects).toHaveBeenNthCalledWith(1, {
      limit: 100,
      continuationToken: undefined,
    })
    expect(testStorage.listProjects).toHaveBeenNthCalledWith(2, {
      limit: 100,
      continuationToken: 'next',
    })
    expect(
      JSON.parse(result.json).map(({ uuid }: { uuid: string }) => uuid),
    ).toEqual(['project-1', 'project-2'])
    expect(calls).toEqual([
      'list-1',
      'list-2',
      'get-project-1',
      'get-project-2',
    ])
  })

  it('matches the Claude projects fixture without unsupported fields', async () => {
    const testStorage = storage({
      listDocuments: vi.fn().mockResolvedValue({
        documents: [
          {
            id: 'document-1',
            projectId: 'project-1',
            sizeBytes: 123,
            syncVersion: 1,
            createdAt: '2026-01-03T03:04:05.000Z',
            updatedAt,
          },
        ],
      }),
      getDocument: vi.fn().mockResolvedValue({
        id: 'document-1',
        projectId: 'project-1',
        filename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: 123,
        syncVersion: 1,
        createdAt,
        updatedAt,
        content: 'Extracted text only',
      } satisfies ProjectDocument),
    })

    const result = await buildClaudeProjectExport(testStorage)

    expect(JSON.parse(result.json)).toEqual(claudeProjectsFixture)
    expect(result.counts).toEqual({
      exportedProjects: 1,
      skippedProjects: 0,
      exportedDocuments: 1,
      skippedDocuments: 0,
      failedDocumentListings: 0,
    })
    expect(result.json).not.toContain('memory')
    expect(result.json).not.toContain('color')
    expect(result.json).not.toContain('contentType')
    expect(result.json).not.toContain('sizeBytes')
  })

  it('aborts when any project-list page fails', async () => {
    const getProject = vi.fn()
    const testStorage = storage({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce({
          projects: [listItem('project-1')],
          hasMore: true,
          nextContinuationToken: 'next',
        })
        .mockRejectedValueOnce(new Error('unavailable')),
      getProject,
    })

    await expect(buildClaudeProjectExport(testStorage)).rejects.toThrow(
      'unavailable',
    )
    expect(getProject).not.toHaveBeenCalled()
  })

  it('keeps the freshest project when pagination returns a duplicate', async () => {
    const stale = { ...listItem('project-1'), updatedAt: createdAt }
    const fresh = { ...listItem('project-1'), syncVersion: 2 }
    const testStorage = storage({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce({
          projects: [fresh],
          hasMore: true,
          nextContinuationToken: 'next',
        })
        .mockResolvedValueOnce({ projects: [stale], hasMore: false }),
    })

    const result = await buildClaudeProjectExport(testStorage)

    expect(JSON.parse(result.json)).toEqual([
      expect.objectContaining({ updated_at: updatedAt }),
    ])
    expect(testStorage.getProject).toHaveBeenCalledOnce()
  })

  it('sorts deduplicated projects by freshness with a stable ID tie-break', async () => {
    const older = { ...listItem('older'), updatedAt: createdAt }
    const first = { ...listItem('first'), syncVersion: 2 }
    const second = { ...listItem('second'), syncVersion: 2 }
    const moved = { ...listItem('moved'), updatedAt: createdAt }
    const refreshedMoved = { ...moved, updatedAt, syncVersion: 3 }
    const testStorage = storage({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce({
          projects: [moved, second, older],
          hasMore: true,
          nextContinuationToken: 'next',
        })
        .mockResolvedValueOnce({
          projects: [first, refreshedMoved],
          hasMore: false,
        }),
    })

    const result = await buildClaudeProjectExport(testStorage)

    expect(
      JSON.parse(result.json).map((item: { uuid: string }) => item.uuid),
    ).toEqual(['moved', 'first', 'second', 'older'])
  })

  it('returns counts and warnings for project and document failures', async () => {
    const testStorage = storage({
      listProjects: vi.fn().mockResolvedValue({
        projects: [
          listItem('missing'),
          listItem('docs-unavailable'),
          listItem('partial'),
        ],
        hasMore: false,
      }),
      getProject: vi
        .fn()
        .mockImplementation(async (id: string) =>
          id === 'missing' ? null : project(id),
        ),
      listDocuments: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'docs-unavailable') throw new Error('unavailable')
        return {
          documents: [
            'good',
            'bad',
            'missing-document',
            'encrypted-document',
          ].map((documentId) => ({
            ...listItem(documentId),
            projectId: id,
            sizeBytes: 1,
          })),
        }
      }),
      getDocument: vi.fn().mockImplementation(async (_projectId, id) => {
        if (id === 'bad') throw new Error('unavailable')
        if (id === 'missing-document') return null
        if (
          _projectId !== 'partial' ||
          !['good', 'encrypted-document'].includes(id)
        )
          throw new Error('Unexpected document read')
        return {
          id,
          projectId: 'partial',
          filename: 'good.txt',
          contentType: 'text/plain',
          sizeBytes: 1,
          syncVersion: 1,
          createdAt,
          updatedAt,
          content: 'text',
          decryptionFailed: id === 'encrypted-document',
        }
      }),
    })

    const result = await buildClaudeProjectExport(testStorage)

    expect(result.counts).toEqual({
      exportedProjects: 2,
      skippedProjects: 1,
      exportedDocuments: 1,
      skippedDocuments: 3,
      failedDocumentListings: 1,
    })
    expect([...result.warnings].sort()).toEqual(
      [
        'Skipped project missing.',
        'Documents for project docs-unavailable could not be listed, so their skipped count is unknown.',
        'Skipped document bad in project partial.',
        'Skipped document missing-document in project partial.',
        'Skipped document encrypted-document in project partial.',
      ].sort(),
    )
    expect(
      JSON.parse(result.json).map(
        ({ uuid, docs }: { uuid: string; docs?: unknown[] }) => ({
          uuid,
          docs,
        }),
      ),
    ).toEqual([
      { uuid: 'docs-unavailable', docs: undefined },
      {
        uuid: 'partial',
        docs: [
          {
            uuid: 'good',
            filename: 'good.txt',
            content: 'text',
            created_at: createdAt,
          },
        ],
      },
    ])
  })

  it('reports unknown skipped documents when a document listing fails', () => {
    const summary = formatClaudeProjectExportCounts({
      exportedProjects: 2,
      skippedProjects: 0,
      exportedDocuments: 3,
      skippedDocuments: 0,
      failedDocumentListings: 1,
    })

    expect(summary).toContain('The skipped document total is unknown')
    expect(summary).toContain('document listing failed for 1 project')
    expect(summary).not.toContain('Skipped 0 projects and 0 documents')
  })

  it('never reads more than four documents concurrently', async () => {
    let active = 0
    let maximumActive = 0
    const documents = Array.from({ length: 10 }, (_, index) => ({
      ...listItem(`document-${index}`),
      projectId: 'project-1',
      sizeBytes: 1,
    }))
    const testStorage = storage({
      listDocuments: vi.fn().mockResolvedValue({ documents }),
      getDocument: vi.fn().mockImplementation(async (_projectId, id) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        active--
        return {
          id,
          projectId: 'project-1',
          filename: `${id}.txt`,
          contentType: 'text/plain',
          sizeBytes: 1,
          syncVersion: 1,
          createdAt,
          updatedAt,
          content: 'text',
        }
      }),
    })

    await buildClaudeProjectExport(testStorage)

    expect(maximumActive).toBe(4)
  })

  it('rejects encoded JSON over the configured bound', async () => {
    await expect(
      buildClaudeProjectExport(storage(), { maxEncodedBytes: 10 }),
    ).rejects.toBeInstanceOf(ClaudeProjectExportSizeError)
  })

  it('applies the encoded bound exactly to pretty-printed output', async () => {
    const testStorage = storage({
      listDocuments: vi.fn().mockResolvedValue({
        documents: [
          {
            ...listItem('document-1'),
            projectId: 'project-1',
            sizeBytes: 4,
          },
        ],
      }),
      getDocument: vi.fn().mockResolvedValue({
        id: 'document-1',
        projectId: 'project-1',
        filename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: 4,
        syncVersion: 1,
        createdAt,
        updatedAt,
        content: 'text',
      }),
    })
    const result = await buildClaudeProjectExport(testStorage)
    const encodedBytes = new TextEncoder().encode(result.json).length

    await expect(
      buildClaudeProjectExport(testStorage, {
        maxEncodedBytes: encodedBytes,
      }),
    ).resolves.toEqual(result)
    await expect(
      buildClaudeProjectExport(testStorage, {
        maxEncodedBytes: encodedBytes - 1,
      }),
    ).rejects.toBeInstanceOf(ClaudeProjectExportSizeError)
  })

  it('applies the encoded bound to an empty export', async () => {
    const emptyStorage = storage({
      listProjects: vi.fn().mockResolvedValue({
        projects: [],
        hasMore: false,
      }),
    })

    await expect(
      buildClaudeProjectExport(emptyStorage, { maxEncodedBytes: 2 }),
    ).resolves.toMatchObject({ json: '[]' })
    await expect(
      buildClaudeProjectExport(emptyStorage, { maxEncodedBytes: 1 }),
    ).rejects.toBeInstanceOf(ClaudeProjectExportSizeError)
  })

  it('stops reading documents when their content exceeds the bound', async () => {
    const documents = Array.from({ length: 8 }, (_, index) => ({
      ...listItem(`document-${index}`),
      projectId: 'project-1',
      sizeBytes: 100,
    }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const getDocument = vi.fn().mockImplementation(async (_projectId, id) => {
      await gate
      return {
        id,
        projectId: 'project-1',
        filename: `${id}.txt`,
        contentType: 'text/plain',
        sizeBytes: 100,
        syncVersion: 1,
        createdAt,
        updatedAt,
        content: 'x'.repeat(100),
      }
    })

    const exporting = buildClaudeProjectExport(
      storage({
        listDocuments: vi.fn().mockResolvedValue({ documents }),
        getDocument,
      }),
      { maxEncodedBytes: 300 },
    )
    const rejected = expect(exporting).rejects.toBeInstanceOf(
      ClaudeProjectExportSizeError,
    )
    try {
      await vi.waitFor(() => expect(getDocument).toHaveBeenCalledTimes(4))
    } finally {
      release()
    }
    await rejected
    await Promise.allSettled(getDocument.mock.results.map(({ value }) => value))
    expect(getDocument.mock.calls.map(([, id]) => id)).toEqual([
      'document-0',
      'document-1',
      'document-2',
      'document-3',
    ])
  })
})
