import { NativeBackupExport } from '@/components/chat/native-backup-export'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../services/harness/thread-fixture'

const CHAT_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const ARCHIVE = new Uint8Array([80, 75, 3, 4, 2])
const photo = {
  id: 'att_photo',
  kind: 'image' as const,
  fileName: 'photo.png',
  mimeType: 'image/jpeg',
  size: 5,
  base64: 'bW9kZWw=',
}
const chat = storedThread(CHAT_ID, {
  title: 'Garden plans',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:01Z',
      content: 'This one?',
      attachments: [photo],
    },
  ],
})

let downloads: { name: string; blob: Blob }[]

resetChatStoresAroundEachTest()

beforeEach(() => {
  signIn()
  downloads = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    downloads.push({ name: '', blob: blob as Blob })
    return `blob:backup-${downloads.length}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads[downloads.length - 1].name = this.download
  })
})

function startBackup() {
  fireEvent.click(screen.getByRole('button', { name: 'Create Tinfoil Backup' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'I understand, create backup' }),
  )
}

// A backup the chat service is still writing, which ends only when its
// request is aborted.
function holdBackup() {
  client.multipart.mockImplementation(
    (_path: string, _form: FormData, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  )
}
const requestSignal = (call = 0) =>
  client.multipart.mock.calls[call][2] as AbortSignal

describe('NativeBackupExport', () => {
  it('sends the chats on this device and the content key, and saves the backup', async () => {
    await localThreadStore('device').update(
      CHAT_ID,
      () => chat,
      new Map([[photo.id, { base64: 'b3JpZ2luYWw=', mimeType: 'image/png' }]]),
    )
    client.multipart.mockResolvedValue(new Response(new Blob([ARCHIVE])))
    render(<NativeBackupExport available />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    )
    expect(screen.getByText(/plaintext and readable/)).toBeVisible()
    expect(client.multipart).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'I understand, create backup' }),
    )

    expect(await screen.findByText('Backup saved successfully.')).toBeVisible()
    const [path, form] = client.multipart.mock.calls[0] as [string, FormData]
    expect(path).toBe('/v1/export')
    const parts = [...form.entries()]
    expect(parts.map(([name]) => name)).toEqual(['options', 'thread', 'file'])
    expect(JSON.parse(form.get('options') as string)).toEqual({
      format: 'native',
      key: KEY,
    })
    expect(JSON.parse(form.get('thread') as string)).toEqual(chat)
    const original = form.get('file') as File
    expect([original.name, original.type, await original.text()]).toEqual([
      photo.id,
      'image/png',
      'original',
    ])
    expect(downloads.map(({ name }) => name)).toEqual(['tinfoil-backup.zip'])
    expect(new Uint8Array(await downloads[0].blob.arrayBuffer())).toEqual(
      ARCHIVE,
    )
  })

  it('hides export when an availability prerequisite is missing', () => {
    render(<NativeBackupExport available={false} />)
    expect(
      screen.queryByRole('button', { name: 'Create Tinfoil Backup' }),
    ).not.toBeInTheDocument()
  })

  it('cancels an active export', async () => {
    holdBackup()
    render(<NativeBackupExport available />)
    startBackup()
    await waitFor(() => expect(client.multipart).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText(/No backup file was saved/)).toBeVisible()
    expect(requestSignal().aborted).toBe(true)
    expect(downloads).toEqual([])
  })

  it('reports a refusal by its own description, and other failures generically', async () => {
    client.multipart
      .mockRejectedValueOnce(
        new HarnessError(
          {
            code: 'RATE_LIMITED',
            message: 'Another archive is being written.',
            action: 'retry',
          },
          429,
        ),
      )
      .mockRejectedValueOnce(new Error('private-chat-id'))
    render(<NativeBackupExport available />)
    startBackup()
    expect(
      await screen.findByText('Another archive is being written.'),
    ).toBeVisible()

    startBackup()
    expect(
      await screen.findByText(
        'The backup could not be created. Check your connection and try again.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('status')).not.toHaveTextContent('private-chat-id')
  })

  it('explains a backup refused for holding more than the chat service can process', async () => {
    client.multipart.mockRejectedValue(
      new HarnessError(
        {
          code: 'ARCHIVE_TOO_LARGE',
          message: 'The backup holds too many items',
          action: 'revise',
        },
        413,
      ),
    )
    render(<NativeBackupExport available />)

    startBackup()

    expect(
      await screen.findByText(
        'This archive is too large for the chat service to process.',
      ),
    ).toBeVisible()
    expect(downloads).toEqual([])
  })

  it('cancels an active export when availability is lost', async () => {
    holdBackup()
    const view = render(<NativeBackupExport available />)
    startBackup()
    await waitFor(() => expect(client.multipart).toHaveBeenCalledOnce())

    view.rerender(<NativeBackupExport available={false} />)

    await waitFor(() => expect(requestSignal().aborted).toBe(true))
    view.rerender(<NativeBackupExport available />)
    expect(screen.queryByText(/No backup file was saved/)).toBeNull()
  })

  it('ignores the outcome of an export that availability loss ended', async () => {
    holdBackup()
    const view = render(<NativeBackupExport available />)
    startBackup()
    await waitFor(() => expect(client.multipart).toHaveBeenCalledOnce())
    view.rerender(<NativeBackupExport available={false} />)
    view.rerender(<NativeBackupExport available />)
    let finish!: (response: Response) => void
    client.multipart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    startBackup()
    await waitFor(() => expect(client.multipart).toHaveBeenCalledTimes(2))
    await act(async () => {})

    expect(requestSignal(0).aborted).toBe(true)
    expect(screen.getByText('Collecting cloud data...')).toBeVisible()
    expect(screen.queryByText(/No backup file was saved/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Create Tinfoil Backup' }),
    ).toBeDisabled()
    await act(async () => {
      finish(new Response(new Blob([ARCHIVE])))
    })
    expect(await screen.findByText('Backup saved successfully.')).toBeVisible()
  })
})
