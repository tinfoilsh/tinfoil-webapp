import { NativeBackupExport } from '@/components/chat/native-backup-export'
import type {
  NativeBackupExportResult,
  runNativeBackupExport,
} from '@/services/native-backup/export'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runExport: vi.fn<typeof runNativeBackupExport>(),
}))
vi.mock('@/services/native-backup/export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/native-backup/export')>()),
  runNativeBackupExport: mocks.runExport,
}))

const completeResult: NativeBackupExportResult = {
  complete: true,
  omitted: 0,
  adjustedRelationships: 0,
  localInventoryUnstable: false,
  warnings: 0,
}

const pendingExport: typeof runNativeBackupExport = (signal, onProgress) => {
  onProgress('collecting')
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    })
  })
}

describe('NativeBackupExport', () => {
  beforeEach(() => {
    mocks.runExport
      .mockReset()
      .mockRejectedValue(new Error('Unexpected export'))
  })

  it('hides export when an availability prerequisite is missing', () => {
    render(<NativeBackupExport available={false} />)
    expect(
      screen.queryByRole('button', { name: 'Create Tinfoil Backup' }),
    ).not.toBeInTheDocument()
  })

  it('requires plaintext confirmation before export', async () => {
    mocks.runExport.mockResolvedValue(completeResult)
    render(<NativeBackupExport available />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    expect(mocks.runExport).not.toHaveBeenCalled()
    expect(screen.getByText(/plaintext and readable/)).toHaveTextContent(
      'sensitive chats, documents, and images',
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )
    await waitFor(() => expect(mocks.runExport).toHaveBeenCalledOnce())
    expect(await screen.findByText('Backup saved successfully.')).toBeVisible()
  })

  it('cancels an active export with its AbortController', async () => {
    mocks.runExport.mockImplementation(pendingExport)
    render(<NativeBackupExport available />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText(/No backup file was saved/)).toBeVisible()
    expect(mocks.runExport.mock.calls[0][0].aborted).toBe(true)
  })

  it('reports a successful partial save without exposing source identifiers', async () => {
    mocks.runExport.mockResolvedValue({
      complete: false,
      omitted: 2,
      adjustedRelationships: 3,
      localInventoryUnstable: true,
      warnings: 3,
    })
    render(<NativeBackupExport available />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )

    expect(await screen.findByText(/saved with warnings/)).toHaveTextContent(
      '2 source items could not be included',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '3 relationships were adjusted',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Local chats changed repeatedly',
    )
    const privateIdentifier = 'private-source-chat-identifier'
    mocks.runExport.mockRejectedValueOnce(new Error(privateIdentifier))
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )
    expect(
      await screen.findByText(
        'The backup could not be created. Check your connection and try again.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('status')).not.toHaveTextContent(privateIdentifier)
  })

  it('cancels an active export when availability is lost', async () => {
    mocks.runExport.mockImplementation(pendingExport)
    const view = render(<NativeBackupExport available />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )
    await waitFor(() => expect(mocks.runExport).toHaveBeenCalledOnce())

    view.rerender(<NativeBackupExport available={false} />)

    await waitFor(() =>
      expect(mocks.runExport.mock.calls[0][0].aborted).toBe(true),
    )
    view.rerender(<NativeBackupExport available />)
    expect(screen.queryByText(/No backup file was saved/)).toBeNull()
  })

  it.each(['success', 'failure'] as const)(
    'ignores stale %s from an invalidated export',
    async (outcome) => {
      let rejectFirst!: (reason: unknown) => void
      let finishFirst!: (result: NativeBackupExportResult) => void
      let finishSecond!: (result: NativeBackupExportResult) => void
      let staleProgress!: Parameters<typeof runNativeBackupExport>[1]
      mocks.runExport
        .mockImplementationOnce((_signal, onProgress) => {
          onProgress('collecting')
          staleProgress = onProgress
          return new Promise<NativeBackupExportResult>((resolve, reject) => {
            finishFirst = resolve
            rejectFirst = reject
          })
        })
        .mockImplementationOnce((_signal, onProgress) => {
          onProgress('writing')
          return new Promise((resolve) => {
            finishSecond = resolve
          })
        })
      const view = render(<NativeBackupExport available />)
      const start = () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
        )
        fireEvent.click(
          screen.getByRole('button', { name: 'I understand, create backup' }),
        )
      }
      start()
      await waitFor(() => expect(mocks.runExport).toHaveBeenCalledOnce())
      view.rerender(<NativeBackupExport available={false} />)
      view.rerender(<NativeBackupExport available />)
      start()
      expect(mocks.runExport).toHaveBeenCalledTimes(2)
      expect(mocks.runExport.mock.calls[0][0].aborted).toBe(true)
      await act(async () => {
        staleProgress('collecting')
        if (outcome === 'success') finishFirst(completeResult)
        else rejectFirst(new DOMException('Canceled', 'AbortError'))
      })
      expect(screen.getByText('Saving archive...')).toBeVisible()
      expect(
        screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
      ).toBeDisabled()
      expect(
        screen.queryByText('Backup saved successfully.'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(/No backup file was saved/),
      ).not.toBeInTheDocument()
      await act(async () => {
        finishSecond(completeResult)
      })
      expect(
        await screen.findByText('Backup saved successfully.'),
      ).toBeVisible()
    },
  )
})
