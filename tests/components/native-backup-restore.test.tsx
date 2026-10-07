import { NativeBackupRestore } from '@/components/chat/native-backup-restore'
import type {
  NativeRestoreResult,
  restoreNativeBackup,
} from '@/services/native-backup/orchestrate'
import type { ImportStatusResponse } from '@/services/sync-enclave/sync-api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  restore: vi.fn<typeof restoreNativeBackup>(),
}))
vi.mock('@/services/native-backup/orchestrate', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/native-backup/orchestrate')
  >()),
  restoreNativeBackup: mocks.restore,
}))

const report = {
  projects: {
    imported: 1,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  },
  project_documents: {
    imported: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  },
  cloud_chats: {
    imported: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  },
  local_chats: {
    imported: 1,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  },
  attachments: {
    imported: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    warnings: [],
    errors: [],
  },
} satisfies NativeRestoreResult['report']

const pendingReport: NativeRestoreResult['report'] = {
  ...report,
  projects: { ...report.projects, imported: 0 },
  local_chats: { ...report.local_chats, imported: 0 },
}

const runningStatus: ImportStatusResponse = {
  status: 'running',
  phase: 'projects',
  imported: 0,
  failed: 0,
  total: 1,
}

function selectArchive(
  container: HTMLElement,
  archive = new File(['backup'], 'backup.zip'),
) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const transfer = new DataTransfer()
  transfer.items.add(archive)
  input.files = transfer.files
  fireEvent.change(input)
  return input
}

describe('NativeBackupRestore', () => {
  beforeEach(() => {
    mocks.restore.mockReset().mockRejectedValue(new Error('Unexpected restore'))
  })

  it('honors its availability gate and displays the plaintext warning', () => {
    const { rerender } = render(
      <NativeBackupRestore available={false} ownerId="owner" />,
    )
    expect(
      screen.queryByRole('button', { name: 'Restore Tinfoil Backup' }),
    ).not.toBeInTheDocument()
    rerender(<NativeBackupRestore available ownerId="owner" />)
    expect(screen.getByText(/plaintext backup/)).toBeVisible()
  })

  it('reports partial restores by kind without unqualified success', async () => {
    mocks.restore.mockResolvedValue({
      state: 'partial' as const,
      report: {
        projects: {
          ...report.projects,
          imported: 1,
          skipped: 2,
          failed: 3,
          blocked: 4,
        },
        project_documents: {
          ...report.project_documents,
          imported: 5,
          skipped: 6,
          failed: 7,
          blocked: 8,
        },
        cloud_chats: {
          ...report.cloud_chats,
          imported: 9,
          skipped: 10,
          failed: 11,
          blocked: 12,
        },
        local_chats: {
          ...report.local_chats,
          imported: 13,
          skipped: 14,
          failed: 15,
          blocked: 16,
        },
        attachments: {
          ...report.attachments,
          imported: 17,
          skipped: 18,
          failed: 19,
          blocked: 20,
          warnings: ['thumbnail unavailable'],
        },
      },
    })
    const updated = vi.fn()
    const { container } = render(
      <NativeBackupRestore
        available
        ownerId="owner"
        onChatsUpdated={updated}
      />,
    )
    selectArchive(container)

    expect(
      await screen.findByText('Backup restored with warnings.'),
    ).toBeVisible()
    expect(
      screen.getByText(/attachments:.*thumbnail unavailable/i),
    ).toBeVisible()
    expect(screen.queryByText('Backup restored successfully.')).toBeNull()
    expect(updated).toHaveBeenCalledOnce()
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent),
    ).toEqual([
      'projects: 1 imported, 2 skipped, 3 failed, 4 blocked',
      'project documents: 5 imported, 6 skipped, 7 failed, 8 blocked',
      'cloud chats: 9 imported, 10 skipped, 11 failed, 12 blocked',
      'local chats: 13 imported, 14 skipped, 15 failed, 16 blocked',
      'attachments: 17 imported, 18 skipped, 19 failed, 20 blocked, warnings: thumbnail unavailable',
    ])
  })

  it('reports a failed asynchronous chat reload instead of success', async () => {
    mocks.restore.mockResolvedValue({
      state: 'completed' as const,
      report,
    })
    const updated = vi.fn(async () => {
      throw new Error('Chat reload failed')
    })
    const { container } = render(
      <NativeBackupRestore
        available
        ownerId="owner"
        onChatsUpdated={updated}
      />,
    )

    selectArchive(container)

    expect(
      await screen.findByText(
        'Backup restored successfully, but chats could not be refreshed. Reload to see restored chats.',
      ),
    ).toBeVisible()
    expect(screen.queryByText('Backup restored successfully.')).toBeNull()
  })

  it('explains pending local restore and allows cancellation', async () => {
    mocks.restore.mockImplementation(
      (_file: File, _owner: string, signal: AbortSignal) =>
        new Promise<NativeRestoreResult>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
          queueMicrotask(() =>
            resolve({ state: 'pending', report: pendingReport }),
          )
        }),
    )
    const first = render(<NativeBackupRestore available ownerId="owner" />)
    selectArchive(first.container)
    expect(
      await screen.findByText(/No local chats were restored/),
    ).toHaveTextContent('reselect this archive')

    const neverFinishes = mocks.restore
      .mockReset()
      .mockImplementation(
        (_file: File, _owner: string, signal: AbortSignal) =>
          new Promise<NativeRestoreResult>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      )
    first.unmount()
    const second = render(<NativeBackupRestore available ownerId="owner" />)
    selectArchive(second.container)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(neverFinishes.mock.calls[0][2].aborted).toBe(true),
    )
  })

  it('closes without aborting after the enclave restore starts', async () => {
    let finish!: (result: NativeRestoreResult) => void
    const runRestore = mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        _signal: AbortSignal,
        events: Parameters<typeof restoreNativeBackup>[3] = {},
      ) => {
        events.onStarted?.(runningStatus)
        return new Promise<NativeRestoreResult>((resolve) => (finish = resolve))
      },
    )
    const { container } = render(
      <NativeBackupRestore available ownerId="owner" />,
    )
    selectArchive(container)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    expect(runRestore.mock.calls[0][2].aborted).toBe(false)
    expect(screen.getByText(/enclave restore continues/i)).toHaveTextContent(
      "We'll email you",
    )
    await act(async () => {
      finish({ state: 'pending', report: pendingReport })
    })
  })

  it('aborts a started restore when its owner changes', async () => {
    const runRestore = mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        signal: AbortSignal,
        events: Parameters<typeof restoreNativeBackup>[3] = {},
      ) => {
        events.onStarted?.(runningStatus)
        return new Promise<NativeRestoreResult>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        )
      },
    )
    const view = render(<NativeBackupRestore available ownerId="owner-a" />)
    selectArchive(view.container)
    await waitFor(() => expect(runRestore).toHaveBeenCalledOnce())

    view.rerender(<NativeBackupRestore available ownerId="owner-b" />)

    expect(runRestore.mock.calls[0][2].aborted).toBe(true)
  })

  it('refreshes chats after an enclave-started restore is unmounted', async () => {
    let finish!: (value: NativeRestoreResult) => void
    mocks.restore.mockImplementationOnce(
      (_file, _owner, _signal, events = {}) => {
        events.onStarted?.(runningStatus)
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    )
    const updated = vi.fn()
    const view = render(
      <NativeBackupRestore
        available
        ownerId="owner"
        onChatsUpdated={updated}
      />,
    )
    selectArchive(view.container)
    view.unmount()
    expect(mocks.restore.mock.calls[0][2].aborted).toBe(false)
    await act(async () => {
      finish({ state: 'completed', report })
    })
    expect(updated).toHaveBeenCalledTimes(1)
  })

  it.each(['late completion', 'abort rejection'] as const)(
    'clears the selected archive immediately on owner change before %s',
    async (outcome) => {
      let finishRestore!: (value: NativeRestoreResult) => void
      mocks.restore.mockImplementationOnce(
        (_file, _owner, signal) =>
          new Promise((resolve, reject) => {
            finishRestore = resolve
            if (outcome === 'abort rejection') {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              })
            }
          }),
      )
      const updated = vi.fn()
      const archive = new File(['owner-a-backup'], 'backup.zip')
      const view = render(
        <NativeBackupRestore
          available
          ownerId="owner-a"
          onChatsUpdated={updated}
        />,
      )
      const input = selectArchive(view.container, archive)
      expect(input.files).toHaveLength(1)
      expect(input.files?.[0]).toBe(archive)
      expect(input.value).not.toBe('')

      view.rerender(
        <NativeBackupRestore
          available
          ownerId="owner-b"
          onChatsUpdated={updated}
        />,
      )
      const invalidatedSelection = {
        value: input.value,
        fileCount: input.files?.length,
      }
      expect(mocks.restore.mock.calls[0][2].aborted).toBe(true)
      await act(async () => {
        if (outcome === 'late completion')
          finishRestore({ state: 'completed', report })
      })

      expect(invalidatedSelection).toEqual({ value: '', fileCount: 0 })
      expect(input.value).toBe('')
      expect(input.files).toHaveLength(0)
      expect(updated).not.toHaveBeenCalled()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
      ).toBeEnabled()

      mocks.restore.mockResolvedValueOnce({ state: 'completed', report })
      selectArchive(view.container, archive)
      expect(mocks.restore).toHaveBeenLastCalledWith(
        archive,
        'owner-b',
        expect.any(AbortSignal),
        expect.objectContaining({
          onStarted: expect.any(Function),
          onPhase: expect.any(Function),
        }),
      )
      expect(
        await screen.findByText('Backup restored successfully.'),
      ).toBeVisible()
      expect(updated).toHaveBeenCalledTimes(1)
      expect(input.value).toBe('')
      expect(input.files).toHaveLength(0)
    },
  )

  it.each(['restore', 'chat refresh', 'abort rejection'] as const)(
    'ignores old-owner completion while waiting for %s',
    async (pendingStage) => {
      let finishRestore!: (value: NativeRestoreResult) => void
      let finishRefresh!: () => void
      mocks.restore.mockImplementationOnce(
        (_file, _owner, signal) =>
          new Promise<NativeRestoreResult>((resolve, reject) => {
            finishRestore = resolve
            if (pendingStage === 'abort rejection') {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              })
            }
          }),
      )
      const updated = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      if (pendingStage === 'chat refresh') {
        updated.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRefresh = resolve
            }),
        )
      }
      const view = render(
        <NativeBackupRestore
          available
          ownerId="owner-a"
          onChatsUpdated={updated}
        />,
      )
      selectArchive(view.container)
      if (pendingStage === 'chat refresh') {
        await act(async () => {
          finishRestore({ state: 'completed', report })
        })
        expect(updated).toHaveBeenCalledTimes(1)
      }
      view.rerender(
        <NativeBackupRestore
          available
          ownerId="owner-b"
          onChatsUpdated={updated}
        />,
      )
      expect(mocks.restore.mock.calls[0][2].aborted).toBe(true)
      expect(
        screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
      ).toBeEnabled()
      let finishNewRestore!: (value: NativeRestoreResult) => void
      mocks.restore.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNewRestore = resolve
          }),
      )
      const successorArchive = new File(
        ['owner-b-backup'],
        'owner-b-backup.zip',
      )
      const successorInput = selectArchive(view.container, successorArchive)
      const successorValue = successorInput.value
      expect(successorValue).not.toBe('')
      expect(successorInput.files?.[0]).toBe(successorArchive)
      await act(async () => {
        if (pendingStage === 'restore')
          finishRestore({ state: 'completed', report })
        else if (pendingStage === 'chat refresh') finishRefresh()
      })
      expect(updated).toHaveBeenCalledTimes(
        pendingStage === 'chat refresh' ? 1 : 0,
      )
      expect(successorInput.value).toBe(successorValue)
      expect(successorInput.files).toHaveLength(1)
      expect(successorInput.files?.[0]).toBe(successorArchive)
      expect(
        screen.queryByText('Backup restored successfully.'),
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
      ).toBeDisabled()
      await act(async () => {
        finishNewRestore({ state: 'completed', report })
      })
      expect(updated).toHaveBeenCalledTimes(
        pendingStage === 'chat refresh' ? 2 : 1,
      )
      expect(screen.getByText('Backup restored successfully.')).toBeVisible()
      expect(successorInput.value).toBe('')
      expect(successorInput.files).toHaveLength(0)
    },
  )

  it('surfaces a terminal failure after the progress view is closed', async () => {
    let finish!: (result: NativeRestoreResult) => void
    mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        _signal: AbortSignal,
        events: Parameters<typeof restoreNativeBackup>[3] = {},
      ) => {
        events.onStarted?.(runningStatus)
        return new Promise<NativeRestoreResult>((resolve) => (finish = resolve))
      },
    )
    const view = render(<NativeBackupRestore available ownerId="owner" />)
    selectArchive(view.container)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    finish({ state: 'failed', failureReason: 'timeout', report })

    const message = await screen.findByRole('status')
    expect(message).toHaveTextContent(/^The cloud restore failed\./)
    expect(message).toHaveTextContent(/ran out of time/i)
    expect(message).toHaveTextContent(/No local chats were restored\.$/)
  })

  it('explains an interrupted restore without a report table', async () => {
    mocks.restore.mockResolvedValue({
      state: 'interrupted',
      jobId: 'job-1',
      report: pendingReport,
    })
    const { container } = render(
      <NativeBackupRestore available ownerId="owner" />,
    )
    selectArchive(container)

    const message = await screen.findByRole('status')
    expect(message).toHaveTextContent(/interrupted/i)
    expect(message).toHaveTextContent("We'll email you")
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('replaces the dismissed progress message after completion', async () => {
    let finish!: (result: NativeRestoreResult) => void
    mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        _signal: AbortSignal,
        events: Parameters<typeof restoreNativeBackup>[3] = {},
      ) => {
        events.onStarted?.(runningStatus)
        return new Promise<NativeRestoreResult>((resolve) => (finish = resolve))
      },
    )
    const view = render(<NativeBackupRestore available ownerId="owner" />)
    selectArchive(view.container)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    finish({ state: 'completed', report })

    expect(
      await screen.findByText('Backup restored successfully.'),
    ).toBeVisible()
  })
})
