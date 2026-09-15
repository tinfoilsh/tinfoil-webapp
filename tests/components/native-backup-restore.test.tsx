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
  const { container } = render(
    <NativeBackupRestore available ownerId="alice" onChatsUpdated={reload} />,
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
    'tinfoil_backup',
    expect.any(AbortSignal),
  )
  expect(reload).toHaveBeenCalledOnce()
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
