import { NativeBackupRestore } from '@/components/chat/native-backup-restore'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { StoredThread } from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../harness-fixture'
import {
  rawRows,
  resetChatStoresAroundEachTest,
  storedThread,
} from '../services/harness/thread-fixture'

const backup = new File(['backup'], 'tinfoil-backup.zip', {
  type: 'application/zip',
})

// A chat the backup kept on a device, with its image's copy for models.
const map = {
  id: 'att_map',
  kind: 'image' as const,
  fileName: 'map.png',
  mimeType: 'image/png',
  size: 8,
  base64: 'bW9kZWw=',
}
const deviceChat = storedThread('restored_trip', {
  title: 'Trip',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-02-01T10:00:01Z',
      content: 'Our map',
      attachments: [map],
    },
  ],
})
// The chat as the chat service returns it, with the original inline.
const deviceChatLine = {
  ...deviceChat,
  messages: [
    {
      ...deviceChat.messages[0],
      attachments: [{ ...map, originalBase64: 'b3JpZ2luYWw=' }],
    },
  ],
}

resetChatStoresAroundEachTest()

// A restore's response: a line per chat for this device, then the last line.
function answerRestore(threads: StoredThread[], done: object) {
  client.multipart.mockImplementation(
    async () =>
      new Response(
        [...threads.map((thread) => ({ thread })), { done }]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(''),
      ),
  )
}

// A restore still uploading, which ends only when its request is aborted.
function holdRestore() {
  client.multipart.mockImplementation(
    (_path: string, _form: FormData, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  )
}

function answerStatus(...statuses: object[]) {
  client.post.mockImplementation(async (path: string) => {
    if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
    return statuses.length > 1 ? statuses.shift() : statuses[0]
  })
}

function selectArchive(container: HTMLElement, archive = backup) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const transfer = new DataTransfer()
  transfer.items.add(archive)
  input.files = transfer.files
  fireEvent.change(input)
  return input
}

const requestSignal = () => client.multipart.mock.calls[0][2] as AbortSignal

async function sentOptions() {
  await waitFor(() => expect(client.multipart).toHaveBeenCalledOnce())
  const [path, form] = client.multipart.mock.calls[0] as [string, FormData]
  const file = form.get('file') as File
  return {
    path,
    names: [...form.keys()],
    options: JSON.parse(form.get('options') as string),
    file: [file.name, await file.text()],
  }
}

const listed = () =>
  screen.getAllByRole('listitem').map((item) => item.textContent)

describe('NativeBackupRestore', () => {
  it('honors its availability gate and displays the plaintext warning', () => {
    signIn()
    const { rerender } = render(
      <NativeBackupRestore available={false} ownerId="alice" />,
    )
    expect(
      screen.queryByRole('button', { name: 'Restore Tinfoil Backup' }),
    ).not.toBeInTheDocument()
    rerender(<NativeBackupRestore available ownerId="alice" />)
    expect(screen.getByText(/plaintext backup/)).toBeVisible()
  })

  it("restores to the cloud with cloud sync and stores the backup's device chats", async () => {
    signIn({ cloud: true })
    answerRestore([deviceChatLine], {
      jobId: 'job-1',
      warnings: ['1 image could not be restored.'],
    })
    const counts = (imported: number) => ({
      imported,
      skipped: 0,
      failed: 0,
      blocked: 0,
    })
    answerStatus({
      status: 'completed',
      imported: 3,
      failed: 0,
      total: 3,
      counts: { project: counts(1), chat: counts(2) },
    })
    const chatsUpdated = vi.fn()
    const projectsUpdated = vi.fn()
    const { container } = render(
      <NativeBackupRestore
        available
        ownerId="alice"
        onChatsUpdated={chatsUpdated}
        onProjectsUpdated={projectsUpdated}
      />,
    )

    selectArchive(container)

    expect(
      await screen.findByText('Backup restored with warnings.'),
    ).toBeVisible()
    expect(await sentOptions()).toEqual({
      path: '/v1/import',
      names: ['options', 'file'],
      options: { target: 'cloud', key: KEY },
      file: ['tinfoil-backup.zip', 'backup'],
    })
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/import/status',
      { jobId: 'job-1' },
      expect.any(AbortSignal),
    )
    expect(await localThreadStore('device').get(deviceChat.id)).toEqual(
      deviceChat,
    )
    expect(await rawRows('attachmentOriginals')).toEqual([
      {
        chatId: deviceChat.id,
        attachmentId: 'att_map',
        base64: 'b3JpZ2luYWw=',
        mimeType: 'image/png',
      },
    ])
    expect(listed()).toEqual([
      'projects: 1 imported, 0 skipped, 0 failed, 0 blocked',
      'cloud chats: 2 imported, 0 skipped, 0 failed, 0 blocked',
      'chats on this device: 1 imported, 0 skipped',
      '1 image could not be restored.',
    ])
    expect(chatsUpdated).toHaveBeenCalledOnce()
    expect(projectsUpdated).toHaveBeenCalledOnce()
  })

  it('lists only the cloud data a backup without device chats restored', async () => {
    signIn({ cloud: true })
    answerRestore([], { jobId: 'job-1', warnings: [] })
    answerStatus({
      status: 'completed',
      imported: 2,
      failed: 0,
      total: 2,
      counts: {
        chat: { imported: 2, skipped: 0, failed: 0, blocked: 0 },
      },
    })
    const { container } = render(
      <NativeBackupRestore available ownerId="alice" />,
    )

    selectArchive(container)

    expect(
      await screen.findByText('Backup restored successfully.'),
    ).toBeVisible()
    expect(listed()).toEqual([
      'cloud chats: 2 imported, 0 skipped, 0 failed, 0 blocked',
    ])
  })

  it('restores on this device without cloud sync, skipping chats it holds', async () => {
    signIn()
    answerRestore([deviceChat], { jobId: null, warnings: [] })
    const { container } = render(
      <NativeBackupRestore available ownerId="alice" />,
    )

    selectArchive(container)

    expect(
      await screen.findByText('Backup restored successfully.'),
    ).toBeVisible()
    expect((await sentOptions()).options).toEqual({ target: 'device' })
    expect(client.post).not.toHaveBeenCalled()
    expect(listed()).toEqual(['chats on this device: 1 imported, 0 skipped'])

    const renamed = { ...deviceChat, title: 'Renamed trip' }
    await localThreadStore('device').update(deviceChat.id, () => renamed)
    selectArchive(container)

    await waitFor(() =>
      expect(listed()).toEqual(['chats on this device: 0 imported, 1 skipped']),
    )
    expect(await localThreadStore('device').get(deviceChat.id)).toEqual(renamed)
  })

  it('reports a failed cloud restore, keeping the device chats it stored', async () => {
    signIn({ cloud: true })
    answerRestore([deviceChat], { jobId: 'job-1', warnings: [] })
    answerStatus({
      status: 'failed',
      imported: 0,
      failed: 0,
      total: 0,
      failureReason: 'timeout',
    })
    const { container } = render(
      <NativeBackupRestore available ownerId="alice" />,
    )

    selectArchive(container)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /^The cloud restore failed\. The restore ran out of time/,
      ),
    )
    expect(await localThreadStore('device').get(deviceChat.id)).toEqual(
      deviceChat,
    )
  })

  it('explains a restore of projects refused without cloud sync', async () => {
    signIn()
    client.multipart.mockRejectedValue(
      new HarnessError(
        {
          code: 'PROJECTS_REQUIRE_CLOUD',
          message: 'Projects are kept in the cloud',
        },
        400,
      ),
    )
    const { container } = render(
      <NativeBackupRestore available ownerId="alice" />,
    )

    selectArchive(container)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /^This file includes projects, which are kept in the cloud\. Turn on cloud sync, then try again\.$/,
      ),
    )
    expect((await sentOptions()).options).toEqual({ target: 'device' })
  })

  it('cancels a restore that is still uploading', async () => {
    signIn({ cloud: true })
    holdRestore()
    const { container } = render(
      <NativeBackupRestore available ownerId="alice" />,
    )
    selectArchive(container)
    expect(screen.getByText('Uploading backup...')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(requestSignal().aborted).toBe(true))
    expect(
      await screen.findByRole('button', { name: 'Restore Tinfoil Backup' }),
    ).toBeEnabled()
  })

  it('closes without aborting once the cloud job runs', async () => {
    signIn({ cloud: true })
    answerRestore([], { jobId: 'job-1', warnings: [] })
    answerStatus({
      status: 'running',
      phase: 'projects',
      imported: 0,
      failed: 0,
      total: 1,
    })
    const view = render(<NativeBackupRestore available ownerId="alice" />)
    selectArchive(view.container)

    expect(
      await screen.findByText('Enclave restore: projects...'),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(requestSignal().aborted).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent(
      "The enclave restore continues. We'll email you when it finishes.",
    )
    view.rerender(<NativeBackupRestore available={false} ownerId="alice" />)
    expect(requestSignal().aborted).toBe(true)
  })

  it("ends a restore when the account changes, clearing the old account's selection", async () => {
    signIn({ cloud: true })
    holdRestore()
    const view = render(<NativeBackupRestore available ownerId="alice" />)
    const input = selectArchive(view.container)
    await waitFor(() => expect(client.multipart).toHaveBeenCalledOnce())
    expect(input.value).not.toBe('')
    expect(
      screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
    ).toBeDisabled()

    view.rerender(<NativeBackupRestore available ownerId="bob" />)

    expect(requestSignal().aborted).toBe(true)
    expect(input.value).toBe('')
    expect(
      screen.getByRole('button', { name: 'Restore Tinfoil Backup' }),
    ).toBeEnabled()
  })
})
