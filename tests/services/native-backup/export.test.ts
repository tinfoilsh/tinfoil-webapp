import { AuthTokenUnavailableError } from '@/services/auth'
import { NativeBackupCollectionError } from '@/services/native-backup/collect'
import {
  nativeBackupExportError,
  runNativeBackupExport,
  type NativeBackupExportDependencies,
} from '@/services/native-backup/export'
import { NativeBackupWriterError } from '@/services/native-backup/write'
import { SyncEnclaveError } from '@/services/sync-enclave'
import { describe, expect, it, vi } from 'vitest'

describe('native backup export orchestration', () => {
  it('collects, formats, commits, and only then downloads', async () => {
    const order: string[] = []
    const signal = new AbortController().signal
    const collected = {
      backupId: '123e4567-e89b-42d3-a456-426614174000',
      createdAt: '2026-08-20T12:00:00.000Z',
      projects: [],
      projectDocuments: [],
      cloudChats: [],
      localChats: [],
      images: [],
      relationships: { projectChats: [], projectDocuments: [], chatImages: [] },
      omissions: [],
      warnings: [],
    }
    const formatted = { manifestBytes: new Uint8Array([1]), files: [] }
    const destination: FileSystemFileHandle = {
      kind: 'file',
      name: 'backup.zip',
      isSameEntry: async (other) => other === destination,
      getFile: async () => {
        throw new Error('Unexpected file read')
      },
      createWritable: async () => {
        throw new Error('Writer is injected')
      },
    }
    let commit!: () => void
    const committed = new Promise<void>((resolve) => {
      commit = resolve
    })
    const written = { kind: 'file', filename: 'backup.zip' } as const
    const dependencies = {
      prepare: vi.fn(async () => {
        order.push('prepare')
        return destination
      }),
      collect: vi.fn(async () => {
        order.push('collect')
        return collected
      }),
      format: vi.fn(() => {
        order.push('format')
        return formatted
      }),
      write: vi.fn(async () => {
        order.push('write')
        await committed
        order.push('commit')
        return written
      }),
      download: vi.fn(() => order.push('download')),
    } satisfies NativeBackupExportDependencies
    const progress: string[] = []

    const exportResult = runNativeBackupExport(
      signal,
      (value) => progress.push(value),
      dependencies,
    )

    await vi.waitFor(() => expect(dependencies.write).toHaveBeenCalledOnce())
    expect(dependencies.download).not.toHaveBeenCalled()
    expect(dependencies.collect).toHaveBeenCalledExactlyOnceWith(signal)
    expect(dependencies.format).toHaveBeenCalledExactlyOnceWith(collected)
    expect(dependencies.write).toHaveBeenCalledExactlyOnceWith(formatted, {
      signal,
      destination,
    })
    commit()
    await exportResult
    expect(order).toEqual([
      'prepare',
      'collect',
      'format',
      'write',
      'commit',
      'download',
    ])
    expect(dependencies.download).toHaveBeenCalledExactlyOnceWith(written)
    expect(progress).toEqual(['collecting', 'formatting', 'writing'])
    expect(dependencies.collect).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('does not format or download after cancellation', async () => {
    const controller = new AbortController()
    const dependencies = {
      prepare: vi.fn(async () => undefined),
      collect: vi.fn(async () => {
        controller.abort()
        return {}
      }),
      format: vi.fn(),
      write: vi.fn(),
      download: vi.fn(),
    } as unknown as NativeBackupExportDependencies

    await expect(
      runNativeBackupExport(controller.signal, vi.fn(), dependencies),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(dependencies.format).not.toHaveBeenCalled()
    expect(dependencies.download).not.toHaveBeenCalled()
  })

  it('reports partial counts from canonical collection warnings', async () => {
    const dependencies = {
      prepare: vi.fn(async () => undefined),
      collect: vi.fn(async () => ({
        omissions: [{ kind: 'relationship' }],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 3,
          },
          {
            code: 'chats_detached_from_omitted_projects',
            category: 'relationship_adjustment',
            count: 2,
          },
          {
            code: 'local_inventory_unstable',
            category: 'source_coverage',
            count: 1,
          },
        ],
      })),
      format: vi.fn(() => ({ manifestBytes: new Uint8Array(), files: [] })),
      write: vi.fn(
        async () =>
          ({
            kind: 'file',
            filename: 'backup.zip',
          }) as const,
      ),
      download: vi.fn(),
    } as unknown as NativeBackupExportDependencies

    await expect(
      runNativeBackupExport(
        new AbortController().signal,
        vi.fn(),
        dependencies,
      ),
    ).resolves.toEqual({
      complete: false,
      omitted: 3,
      adjustedRelationships: 2,
      localInventoryUnstable: true,
      warnings: 3,
    })
  })

  it('returns actionable errors for expected failures', () => {
    expect(
      nativeBackupExportError(
        new NativeBackupCollectionError('cloud chat', 'chat-1', 'missing'),
      ),
    ).toContain('changed or went missing')
    expect(
      nativeBackupExportError(
        new NativeBackupWriterError('compressed_limit', 'too large'),
      ),
    ).toContain('too large')
    expect(
      nativeBackupExportError(new DOMException('Denied', 'NotAllowedError')),
    ).toContain('Allow file downloads')
    expect(
      nativeBackupExportError(new DOMException('Canceled', 'AbortError')),
    ).toContain('No backup file was saved')
    expect(
      nativeBackupExportError(
        new NativeBackupCollectionError('account', 'active', 'unavailable'),
      ),
    ).toContain('Sign in again')
    expect(
      nativeBackupExportError(
        new NativeBackupCollectionError('account', 'user-1', 'locked'),
      ),
    ).toContain('Unlock your cloud encryption key')
    expect(
      nativeBackupExportError(new AuthTokenUnavailableError('unavailable')),
    ).toContain('Sign in again')
    expect(nativeBackupExportError(new SyncEnclaveError('', 401))).toContain(
      'Sign in again',
    )
  })
})
