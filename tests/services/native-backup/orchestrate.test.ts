import type { Chat } from '@/components/chat/types'
import { restoreNativeBackup } from '@/services/native-backup/orchestrate'
import type { ValidatedNativeRestore } from '@/services/native-backup/restore'
import { SyncEnclaveError } from '@/services/sync-enclave'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const sourceFile = new File(['plaintext'], 'backup.zip')
const cloudFile = new File(['cloud-only'], 'cloud.zip')
const backupId = '123e4567-e89b-42d3-a456-426614174000'
type RestoreDependencies = NonNullable<
  Parameters<typeof restoreNativeBackup>[4]
>
const localChat: ValidatedNativeRestore['local']['chats'][number] = {
  id: 'source-chat',
  title: 'Local chat',
  messages: [
    {
      role: 'user' as const,
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  projectId: 'source-project',
}

function validated(cloud = true): ValidatedNativeRestore {
  return {
    backup: {
      format: 'tinfoil-native-backup',
      version: 1,
      backup_id: backupId,
      created_at: localChat.createdAt,
      complete: true,
      counts: {
        projects: cloud ? 1 : 0,
        project_documents: 0,
        cloud_chats: 0,
        local_chats: 1,
        relationships: cloud ? 1 : 0,
        images: 0,
        files: 0,
      },
      notices: {
        contains_plaintext: true,
        documents_are_extracted_text_only: true,
      },
      files: [],
    },
    local: {
      chats: [
        {
          ...structuredClone(localChat),
          projectId: cloud ? localChat.projectId : undefined,
        },
      ],
      images: [],
    },
    cloud: cloud
      ? {
          manifest: {
            format: 'tinfoil-native-cloud-import',
            version: 1,
            source_backup_id: backupId,
            counts: { projects: 1, documents: 0, chats: 0, blobs: 0 },
            entities: [],
            blobs: [],
          },
          upload: {
            kind: 'blob',
            blob: cloudFile,
            filename: 'cloud.zip',
          },
        }
      : null,
  }
}

describe('restoreNativeBackup', () => {
  let saveChat: ReturnType<
    typeof vi.fn<(chat: Chat, skipCloudSync?: boolean) => Promise<Chat | null>>
  >
  let dependencies: {
    [K in keyof RestoreDependencies]: Mock<RestoreDependencies[K]>
  }

  beforeEach(() => {
    saveChat = vi.fn(async (chat) => chat)
    dependencies = {
      validate: vi.fn<RestoreDependencies['validate']>(async () => validated()),
      upload: vi.fn<RestoreDependencies['upload']>(async () => ({
        jobId: 'job-1',
        status: {
          status: 'completed',
          imported: 1,
          failed: 0,
          total: 1,
          project_mappings: { 'source-project': 'destination-project' },
        },
      })),
      status: vi.fn<RestoreDependencies['status']>(async () => {
        throw new Error('Unexpected status poll')
      }),
      forEachImage: vi.fn<RestoreDependencies['forEachImage']>(
        async (images) => {
          if (images.length) throw new Error('Unexpected image read')
        },
      ),
      getChat: vi.fn<RestoreDependencies['getChat']>(async () => null),
      saveChat,
      wait: vi.fn<RestoreDependencies['wait']>(async () => undefined),
    }
  })

  it('uploads only the cloud package and restores local chats with mapped projects', async () => {
    const signal = new AbortController().signal
    const result = await restoreNativeBackup(
      sourceFile,
      'destination-owner',
      signal,
      {},
      dependencies,
    )

    expect(dependencies.upload).toHaveBeenCalledWith(
      'tinfoil_backup',
      expect.objectContaining({ name: 'cloud.zip' }),
      { signal },
    )
    expect(dependencies.upload.mock.calls[0][1]).not.toBe(sourceFile)
    expect(await dependencies.upload.mock.calls[0][1].text()).toBe('cloud-only')
    expect(saveChat.mock.calls[0][0]).toMatchObject({
      projectId: 'destination-project',
      syncUserId: 'destination-owner',
      isLocalOnly: true,
    })
    expect(result.report.projects.imported).toBe(1)
    expect(saveChat.mock.calls[0][1]).toBe(true)
    expect(result.state).toBe('completed')
  })

  it('uses deterministic owner-scoped IDs and skips an existing owner row', async () => {
    dependencies.validate.mockResolvedValue(validated(false))
    const rows = new Map<string, Chat>()
    dependencies.getChat.mockImplementation(
      async (id: string) => rows.get(id) ?? null,
    )
    saveChat.mockImplementation(async (chat) => {
      rows.set(chat.id, chat)
      return chat
    })
    await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    const id = saveChat.mock.calls[0][0].id
    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    expect(saveChat).toHaveBeenCalledTimes(1)
    expect(dependencies.getChat).toHaveBeenNthCalledWith(2, id)
    await restoreNativeBackup(
      sourceFile,
      'owner-b',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.local_chats.skipped).toBe(1)
    expect(saveChat.mock.calls[1][0].id).not.toBe(id)
    const changedBackup = validated(false)
    changedBackup.backup.backup_id = '123e4567-e89b-42d3-a456-426614174001'
    dependencies.validate.mockResolvedValue(changedBackup)
    await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    const changedSource = validated(false)
    changedSource.local.chats[0].id = 'another-source'
    dependencies.validate.mockResolvedValue(changedSource)
    await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    expect(new Set(saveChat.mock.calls.map(([chat]) => chat.id)).size).toBe(4)

    dependencies.validate.mockResolvedValue(validated(false))
    rows.set(id, { ...rows.get(id)!, id, syncUserId: 'foreign-owner' })
    const blocked = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    expect(blocked.report.local_chats).toMatchObject({
      imported: 0,
      skipped: 0,
      blocked: 1,
    })
    expect(saveChat).toHaveBeenCalledTimes(4)
  })

  it('surfaces partial source coverage through the restore report', async () => {
    const value = validated(false)
    value.backup = {
      ...value.backup,
      version: 2,
      complete: false,
      omissions: [
        {
          kind: 'cloud_chat',
          source_id: 'private-source-id',
          category: 'invalid',
          reason: 'chat_payload_invalid',
        },
      ],
      warnings: [
        {
          code: 'source_items_omitted',
          category: 'source_coverage',
          count: 1,
        },
      ],
    } as ValidatedNativeRestore['backup']
    dependencies.validate.mockResolvedValue(value)

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.state).toBe('partial')
    expect(result.report.cloud_chats.warnings).toEqual([
      'Source archive omitted 1 cloud chat.',
    ])
    expect(JSON.stringify(result.report)).not.toContain('private-source-id')
  })

  it('reports relationship adjustments separately from omitted cloud chats', async () => {
    const value = validated(false)
    value.backup = {
      ...value.backup,
      version: 2,
      complete: false,
      omissions: [
        {
          kind: 'relationship',
          source_id: 'private-chat-id',
          parent_source_id: 'private-project-id',
          category: 'unavailable',
          reason: 'project_reference_unavailable',
        },
      ],
      warnings: [
        {
          code: 'chats_detached_from_omitted_projects',
          category: 'relationship_adjustment',
          count: 1,
        },
      ],
    } as ValidatedNativeRestore['backup']
    dependencies.validate.mockResolvedValue(value)

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.cloud_chats.warnings).toEqual([
      'Source archive adjusted 1 relationship to keep restored data valid.',
    ])
    expect(result.report.cloud_chats.warnings[0]).not.toContain('omitted')
  })

  it('attributes relationship adjustments for local source chat IDs locally', async () => {
    const value = validated(false)
    value.local.chats[0].projectId = undefined
    value.backup = {
      ...value.backup,
      version: 2,
      complete: false,
      omissions: [
        {
          kind: 'relationship',
          source_id: localChat.id,
          parent_source_id: 'private-project-id',
          category: 'unavailable',
          reason: 'project_reference_unavailable',
        },
      ],
      warnings: [
        {
          code: 'chats_detached_from_omitted_projects',
          category: 'relationship_adjustment',
          count: 1,
        },
      ],
    } as ValidatedNativeRestore['backup']
    dependencies.validate.mockResolvedValue(value)

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.local_chats.warnings).toEqual([
      'Source archive adjusted 1 relationship to keep restored data valid.',
    ])
    expect(result.report.cloud_chats.warnings).toEqual([])
  })

  it('does not count a skipped storage write as imported', async () => {
    dependencies.validate.mockResolvedValue(validated(false))
    saveChat.mockResolvedValue(null)

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.local_chats).toMatchObject({ imported: 0, failed: 1 })
    expect(result.state).toBe('partial')
  })

  it('treats a legacy owner row as an idempotent restore', async () => {
    dependencies.validate.mockResolvedValue(validated(false))
    await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    const id = saveChat.mock.calls[0][0].id
    dependencies.getChat.mockImplementation(async (requestedId: string) =>
      requestedId === id
        ? {
            ...saveChat.mock.calls[0][0],
            id,
            syncUserId: undefined,
            userId: 'owner-a',
          }
        : null,
    )

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.local_chats.skipped).toBe(1)
    expect(saveChat).toHaveBeenCalledTimes(1)
  })

  it('uses service counts for an idempotent cloud restore', async () => {
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: {
        status: 'completed',
        imported: 0,
        failed: 0,
        total: 1,
        counts: {
          project: { imported: 0, skipped: 1, failed: 0, blocked: 0 },
        },
      },
    })

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.projects).toMatchObject({ imported: 0, skipped: 1 })
  })

  it('preserves aggregate failures and all image counts without service counts', async () => {
    const value = validated()
    value.backup.counts = {
      projects: 1,
      project_documents: 0,
      cloud_chats: 1,
      local_chats: 0,
      relationships: 2,
      images: 2,
      files: 0,
    }
    value.cloud!.manifest.counts = {
      projects: 1,
      documents: 0,
      chats: 1,
      blobs: 0,
    }
    dependencies.validate.mockResolvedValue(value)
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: {
        status: 'completed',
        imported: 1,
        failed: 1,
        total: 2,
      },
    })

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result.report.cloud_chats.failed).toBe(1)
    expect(result.report.attachments.imported).toBe(2)
    expect(result.state).toBe('partial')
  })

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    'restores image occurrences and counts outcomes with duplicate IDs: %s, documents: %s',
    async (duplicateIds, documents) => {
      const value = validated(false)
      value.local.chats[0].messages[0].attachments = [
        { id: 'attachment-1', type: 'image', imageId: 'image-1' },
        {
          id: duplicateIds ? 'attachment-1' : 'attachment-2',
          type: 'image',
          imageId: 'image-2',
        },
      ]
      if (documents)
        value.local.chats[0].messages[0].attachments = [1, 2].map((number) => ({
          id: 'attachment-1',
          type: 'document',
          fileName: `document-${number}.pdf`,
          pages: [
            {
              page: 0,
              text: `page-${number}`,
              is_scanned: true,
              imageId: `image-${number}`,
            },
          ],
        }))
      value.local.images = [1, 2].map((number) => ({
        metadata: {
          id: `image-${number}`,
          chatId: 'source-chat',
          messageIndex: 0,
          attachmentId: duplicateIds ? 'attachment-1' : `attachment-${number}`,
          fileName: `image-${number}.png`,
          mimeType: 'image/png',
          ...(documents ? { page: 0 } : {}),
        },
        source: {
          file: sourceFile,
          path: `image-${number}`,
          sizeBytes: 1,
          sha256: 'hash',
        },
      }))
      dependencies.validate.mockResolvedValue(value)
      dependencies.forEachImage.mockImplementation(async (images, consume) => {
        for (const image of images) {
          await consume({
            metadata: image.metadata,
            bytes: new Uint8Array([image.metadata.id === 'image-1' ? 1 : 2]),
          })
        }
      })

      const imported = await restoreNativeBackup(
        sourceFile,
        'owner-a',
        new AbortController().signal,
        {},
        dependencies,
      )
      const id = saveChat.mock.calls[0][0].id
      dependencies.getChat.mockResolvedValue({
        ...saveChat.mock.calls[0][0],
        id,
        syncUserId: 'owner-a',
      })
      const skipped = await restoreNativeBackup(
        sourceFile,
        'owner-a',
        new AbortController().signal,
        {},
        dependencies,
      )
      dependencies.getChat.mockResolvedValue(null)
      saveChat.mockRejectedValueOnce(new Error('save failed'))
      const failed = await restoreNativeBackup(
        sourceFile,
        'owner-b',
        new AbortController().signal,
        {},
        dependencies,
      )

      expect(saveChat.mock.calls[0][0].messages[0].attachments).toMatchObject(
        documents
          ? [
              {
                id: 'attachment-1',
                fileName: 'document-1.pdf',
                pages: [{ page: 0, text: 'page-1', image: 'AQ==' }],
              },
              {
                id: 'attachment-1',
                fileName: 'document-2.pdf',
                pages: [{ page: 0, text: 'page-2', image: 'Ag==' }],
              },
            ]
          : [
              { id: 'attachment-1', fileName: 'image-1.png', base64: 'AQ==' },
              {
                id: duplicateIds ? 'attachment-1' : 'attachment-2',
                fileName: 'image-2.png',
                base64: 'Ag==',
              },
            ],
      )
      expect(imported.report.attachments.imported).toBe(2)
      expect(skipped.report.attachments.skipped).toBe(2)
      expect(failed.report.attachments.failed).toBe(2)
      expect(dependencies.forEachImage).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['running', 'failed'] as const)(
    'does not restore local chats when the cloud job is %s',
    async (status) => {
      dependencies.upload.mockResolvedValue({
        jobId: 'job-1',
        status: { status, imported: 0, failed: 0, total: 1 },
      })
      dependencies.status.mockResolvedValue({
        status,
        imported: 0,
        failed: status === 'failed' ? 1 : 0,
        total: 1,
      })

      const result = await restoreNativeBackup(
        sourceFile,
        'owner-a',
        new AbortController().signal,
        {},
        dependencies,
      )

      expect(result.state).toBe(status === 'running' ? 'pending' : 'failed')
      expect(saveChat).not.toHaveBeenCalled()
    },
  )

  it('carries the enclave failure reason on a failed cloud job', async () => {
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: { status: 'running', imported: 0, failed: 0, total: 1 },
    })
    dependencies.status.mockResolvedValue({
      status: 'failed',
      imported: 0,
      failed: 0,
      total: 1,
      errors: ['import timed out'],
      failure_reason: 'timeout',
    })

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result).toMatchObject({ state: 'failed', failureReason: 'timeout' })
    expect(result.report.cloud_chats.errors).toEqual(['import timed out'])
    expect(saveChat).not.toHaveBeenCalled()
  })

  it('reports an interrupted restore when the enclave forgets the job mid-poll', async () => {
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: { status: 'running', imported: 0, failed: 0, total: 1 },
    })
    dependencies.status.mockRejectedValue(
      new SyncEnclaveError('import job not found', 404, 'NOT_FOUND'),
    )

    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )

    expect(result).toMatchObject({ state: 'interrupted', jobId: 'job-1' })
    expect(dependencies.status).toHaveBeenCalledOnce()
    expect(saveChat).not.toHaveBeenCalled()
  })

  it('rethrows status poll failures other than a missing job', async () => {
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: { status: 'running', imported: 0, failed: 0, total: 1 },
    })
    dependencies.status.mockRejectedValue(
      new SyncEnclaveError('sync enclave request failed: 503', 503, 'HTTP_503'),
    )

    await expect(
      restoreNativeBackup(
        sourceFile,
        'owner-a',
        new AbortController().signal,
        {},
        dependencies,
      ),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('detaches chats from failed projects and treats warnings as partial', async () => {
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: {
        status: 'completed',
        imported: 0,
        failed: 1,
        total: 1,
        counts: {
          chat: { imported: 0, skipped: 0, failed: 1, blocked: 0 },
        },
        warnings: ['thumbnail unavailable'],
        errors: ['chat failed'],
        phase: 'complete',
      },
    })

    const onPhase = vi.fn()
    const result = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      { onPhase },
      dependencies,
    )

    expect(saveChat.mock.calls[0][0].projectId).toBeUndefined()
    expect(result.report.local_chats.warnings).toHaveLength(1)
    expect(result.report.cloud_chats.failed).toBe(1)
    expect(result.report.cloud_chats.errors).toEqual(['chat failed'])
    expect(result.report.attachments.warnings).toEqual([
      'thumbnail unavailable',
    ])
    expect(onPhase).toHaveBeenCalledWith('complete')
    expect(result.state).toBe('partial')
    expect(result.report.local_chats.warnings).toEqual([
      'Restored "Local chat" without its unavailable project.',
    ])
    dependencies.upload.mockResolvedValue({
      jobId: 'job-1',
      status: {
        status: 'completed',
        imported: 1,
        failed: 0,
        total: 1,
        counts: { project: { imported: 1, skipped: 0, failed: 0, blocked: 0 } },
        project_mappings: { 'source-project': 'destination-project' },
        warnings: ['thumbnail unavailable'],
        errors: [],
      },
    })
    const warningOnly = await restoreNativeBackup(
      sourceFile,
      'owner-a',
      new AbortController().signal,
      {},
      dependencies,
    )
    expect(warningOnly.state).toBe('partial')
    expect(warningOnly.report.local_chats.warnings).toEqual([])
    expect(warningOnly.report.cloud_chats.errors).toEqual([])
    expect(warningOnly.report.attachments.warnings).toEqual([
      'thumbnail unavailable',
    ])
  })
})
