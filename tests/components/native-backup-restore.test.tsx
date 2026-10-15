import { NativeBackupRestore } from '@/components/chat/native-backup-restore'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  startImport: vi.fn(),
  importStatus: vi.fn(),
}))
vi.mock('@/services/harness/archives', () => mocks)
beforeEach(() => {
  mocks.startImport.mockReset()
  mocks.importStatus.mockReset()
})
function choose(container: HTMLElement) {
  fireEvent.change(container.querySelector('input')!, {
    target: { files: [new File(['archive'], 'backup.zip')] },
  })
}
it('uploads the archive and displays server warnings and counts', async () => {
  mocks.startImport.mockResolvedValue({
    status: 'partial',
    jobId: 'job',
    counts: { chats: { imported: 2, skipped: 1, failed: 1, blocked: 0 } },
  })
  const reload = vi.fn()
  const reloadProjects = vi.fn()
  const { container } = render(
    <NativeBackupRestore
      available
      ownerId="alice"
      onChatsUpdated={reload}
      onProjectsUpdated={reloadProjects}
    />,
  )
  choose(container)
  expect(
    await screen.findByText('Backup restored with warnings.'),
  ).toBeVisible()
  expect(
    screen.getByText('chats: 2 imported, 1 skipped, 1 failed, 0 blocked'),
  ).toBeVisible()
  expect(mocks.startImport).toHaveBeenCalledWith(
    expect.any(File),
    'tinfoil',
    expect.any(AbortSignal),
  )
  expect(reload).toHaveBeenCalledOnce()
  // A backup restores projects as well as chats.
  await waitFor(() => expect(reloadProjects).toHaveBeenCalledOnce())
})
it('checks an accepted import by job id without reuploading', async () => {
  mocks.startImport.mockResolvedValue({ status: 'running', jobId: 'job' })
  mocks.importStatus.mockResolvedValue({ status: 'completed', jobId: 'job' })
  const { container } = render(
    <NativeBackupRestore available ownerId="alice" />,
  )
  choose(container)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check restore progress' }),
  )
  expect(await screen.findByText('Backup restored successfully.')).toBeVisible()
  expect(mocks.startImport).toHaveBeenCalledOnce()
  expect(mocks.importStatus).toHaveBeenCalledWith(
    'job',
    expect.any(AbortSignal),
  )
})
it('ignores a restore response when the owner changes', async () => {
  let resolve!: (value: unknown) => void
  mocks.startImport.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const view = render(<NativeBackupRestore available ownerId="alice" />)
  choose(view.container)
  await waitFor(() => expect(mocks.startImport).toHaveBeenCalledOnce())
  view.rerender(<NativeBackupRestore available ownerId="bob" />)
  expect(mocks.startImport.mock.calls[0][2].aborted).toBe(true)
  await act(async () => resolve({ status: 'completed' }))
  expect(
    screen.queryByText('Backup restored successfully.'),
  ).not.toBeInTheDocument()
})
it('lets the same archive be chosen again after waiting is cancelled', async () => {
  mocks.startImport.mockReturnValue(new Promise(() => {}))
  const { container } = render(
    <NativeBackupRestore available ownerId="alice" />,
  )
  const input = container.querySelector('input')!
  // The browser fires change for a choice only when it differs from the
  // value the input still holds.
  Object.defineProperty(input, 'value', {
    configurable: true,
    writable: true,
    value: 'C:\\fakepath\\backup.zip',
  })
  choose(container)

  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(input.value).toBe('')
  expect(
    screen.getByText(
      'Stopped waiting. Any accepted restore continues on the server.',
    ),
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
  ).toBeEnabled()
})
it('explains why the server rejected a restore', async () => {
  mocks.startImport.mockResolvedValue({
    status: 'failed',
    jobId: 'job',
    failureReason: 'key_mismatch',
  })
  const reload = vi.fn()
  const { container } = render(
    <NativeBackupRestore available ownerId="alice" onChatsUpdated={reload} />,
  )
  choose(container)
  expect(
    await screen.findByText(
      'Backup restore failed. The encryption key used for the restore no longer matches the key on your account. Nothing was written; try the restore again.',
    ),
  ).toBeVisible()
  expect(reload).not.toHaveBeenCalled()
})
