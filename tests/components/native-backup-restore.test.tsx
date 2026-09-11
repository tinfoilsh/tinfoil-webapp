import { NativeBackupRestore } from '@/components/chat/native-backup-restore'
import type { NativeRestoreResult } from '@/services/native-backup/orchestrate'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ restore: vi.fn() }))
vi.mock('@/services/native-backup/orchestrate', () => ({
  NATIVE_RESTORE_KINDS: [
    'projects',
    'project_documents',
    'cloud_chats',
    'local_chats',
    'attachments',
  ],
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

function selectArchive(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]')!
  fireEvent.change(input, {
    target: { files: [new File(['backup'], 'backup.zip')] },
  })
}

describe('NativeBackupRestore', () => {
  beforeEach(() => {
    mocks.restore.mockReset()
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
        ...report,
        attachments: {
          ...report.attachments,
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
          queueMicrotask(() => resolve({ state: 'pending', report }))
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
        events: { onStarted(status: any): void },
      ) => {
        events.onStarted({ status: 'running', phase: 'projects' })
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
    finish({ state: 'pending', report })
  })

  it('aborts a started restore when its owner changes', async () => {
    const runRestore = mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        signal: AbortSignal,
        events: { onStarted(status: any): void },
      ) => {
        events.onStarted({ status: 'running' })
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

  it('surfaces a terminal failure after the progress view is closed', async () => {
    let finish!: (result: NativeRestoreResult) => void
    mocks.restore.mockImplementation(
      (
        _file: File,
        _owner: string,
        _signal: AbortSignal,
        events: { onStarted(status: any): void },
      ) => {
        events.onStarted({ status: 'running' })
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
      report,
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
        events: { onStarted(status: any): void },
      ) => {
        events.onStarted({ status: 'running' })
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
