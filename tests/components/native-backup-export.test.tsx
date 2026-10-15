import { NativeBackupExport } from '@/components/chat/native-backup-export'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exportArchive: vi.fn() }))
vi.mock('@/services/harness/archives', () => mocks)
beforeEach(() => {
  mocks.exportArchive.mockReset()
})
it('requires plaintext confirmation before asking the harness for an archive', async () => {
  mocks.exportArchive.mockResolvedValue(undefined)
  render(<NativeBackupExport available />)
  fireEvent.click(screen.getByRole('button', { name: 'Create Tinfoil Backup' }))
  expect(mocks.exportArchive).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: 'I understand, create backup' }),
  )
  await waitFor(() =>
    expect(mocks.exportArchive).toHaveBeenCalledWith(
      'tinfoil-backup',
      expect.any(AbortSignal),
    ),
  )
  expect(await screen.findByText('Backup saved successfully.')).toBeVisible()
})
it('aborts export and ignores its completion if the key becomes unavailable', async () => {
  let finish!: () => void
  mocks.exportArchive.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const view = render(<NativeBackupExport available />)
  fireEvent.click(screen.getByRole('button', { name: 'Create Tinfoil Backup' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'I understand, create backup' }),
  )
  await waitFor(() => expect(mocks.exportArchive).toHaveBeenCalledOnce())
  const signal = mocks.exportArchive.mock.calls[0][1] as AbortSignal
  view.rerender(<NativeBackupExport available={false} />)
  expect(signal.aborted).toBe(true)
  finish()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
