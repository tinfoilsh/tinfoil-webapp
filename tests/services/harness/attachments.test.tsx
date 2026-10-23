import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { Thread } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const THREAD_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'

const thread: Thread = {
  id: THREAD_ID,
  title: 'Reports',
  titleState: 'generated',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:00Z',
  model: 'test-model',
  projectId: null,
  pinned: false,
  webSearchEnabled: true,
  messageCount: 1,
  activeRun: null,
  hasOlder: false,
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'Summarize these',
      attachments: [
        {
          id: 'att_report',
          kind: 'document',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          size: 2048,
        },
        {
          id: 'att_chart',
          kind: 'image',
          fileName: 'chart.png',
          mimeType: 'image/png',
          size: 512,
          thumbnail: 'dGh1bWI=',
        },
      ],
    },
  ],
}

resetChatStoresAroundEachTest()

describe('attachments of a stored chat', () => {
  async function openStored() {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? structuredClone(thread)
        : { threads: [], nextCursor: null },
    )
    const hook = renderHook(() => useThread(THREAD_ID, null))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(1),
    )
    return hook
  }

  it('downloads a full-size image under its chat', async () => {
    const { result } = await openStored()
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    client.download.mockResolvedValue(image)
    const [, chart] = result.current.chat.messages[0].attachments!

    const blob = await result.current.loadImage(chart)

    expect(blob).toBe(image)
    expect(client.download).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/get',
      { key: KEY, id: 'att_chart', threadId: THREAD_ID },
      expect.any(AbortSignal),
    )
  })

  it("reads a document's text from the harness once", async () => {
    const { result } = await openStored()
    const [report] = result.current.chat.messages[0].attachments!
    expect(report.textContent).toBeUndefined()
    client.download.mockResolvedValue(
      new Blob(['# Report\n\nRevenue grew.'], { type: 'text/markdown' }),
    )

    const [first, second] = await Promise.all([
      result.current.documentText(report),
      result.current.documentText(report),
    ])

    expect(first).toBe('# Report\n\nRevenue grew.')
    expect(second).toBe(first)
    expect(client.download).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/get',
      { key: KEY, id: 'att_report', threadId: THREAD_ID },
      expect.any(AbortSignal),
    )
  })

  it('reads a document again after a failed read', async () => {
    const { result } = await openStored()
    const [report] = result.current.chat.messages[0].attachments!
    client.download
      .mockRejectedValueOnce(
        new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'offline' }),
      )
      .mockResolvedValueOnce(new Blob(['Recovered']))

    await expect(result.current.documentText(report)).rejects.toThrow('offline')
    expect(await result.current.documentText(report)).toBe('Recovered')
    expect(client.download).toHaveBeenCalledTimes(2)
  })
})

describe('attachments of a local chat', () => {
  it("reads a document's text from its stored pages without the harness", async () => {
    signIn({ cloud: false })
    const local = storedThread(THREAD_ID, {
      title: 'Scans',
      titleState: 'generated',
      messages: [
        {
          id: 'u1',
          role: 'user',
          createdAt: '2026-04-01T09:00:00Z',
          content: 'Read this scan',
          attachments: [
            {
              id: 'att_scan',
              kind: 'document',
              fileName: 'scan.pdf',
              mimeType: 'application/pdf',
              size: 9,
              pages: [
                { page: 1, text: 'First page', image: '', is_scanned: true },
                { page: 2, text: '', image: '', is_scanned: true },
                { page: 3, text: 'Third page', image: '', is_scanned: true },
              ],
            },
          ],
        },
      ],
    })
    await localThreadStore('device').update(THREAD_ID, () => local)
    const { result } = renderHook(() =>
      useThread(THREAD_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(1))
    const [scan] = result.current.chat.messages[0].attachments!

    expect(await result.current.documentText(scan)).toBe(
      'First page\n\nThird page',
    )
    expect(client.download).not.toHaveBeenCalled()
  })
})

describe('picking a file to attach', () => {
  // The session takes .png files up to 1000 bytes, and .pdf and .txt files
  // up to 2000. Picked files carry no type, so only the name tells them
  // apart. A file of a type no group names goes as text, which the harness
  // reads if it is.
  it.each([
    { name: 'photo.png', size: 1000, refused: null },
    { name: 'PHOTO.PNG', size: 1001, refused: 413 },
    { name: 'notes.v2.txt', size: 2000, refused: null },
    { name: 'report.pdf', size: 2001, refused: 413 },
    { name: 'Dockerfile', size: 2000, refused: null },
    { name: 'archive.zip', size: 2001, refused: 413 },
  ])(
    'uploads $name of $size bytes unless its group refuses it ($refused)',
    async ({ name, size, refused }) => {
      signIn({ cloud: true })
      const descriptor = {
        id: 'att_1',
        kind: 'document',
        fileName: name,
        mimeType: 'application/octet-stream',
        size,
      }
      client.upload.mockResolvedValue({ attachment: descriptor })
      const { result } = renderHook(() => useThread())
      const picked = new File([new Uint8Array(size)], name)

      const upload = result.current.upload(picked)

      if (!refused) {
        await expect(upload).resolves.toEqual(descriptor)
        expect(client.upload).toHaveBeenCalledExactlyOnceWith(
          '/v1/attachments/upload',
          picked,
          {},
          expect.any(AbortSignal),
        )
      } else {
        await expect(upload).rejects.toMatchObject({
          status: refused,
          code:
            refused === 413 ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_UNSUPPORTED',
        })
        expect(client.upload).not.toHaveBeenCalled()
      }
    },
  )

  it('refuses a file of an unlisted type when no group takes text', async () => {
    signIn({
      cloud: true,
      session: {
        ...testSession,
        composer: {
          ...testSession.composer,
          attachments: [{ accept: ['.png'], maxBytes: 1000 }],
        },
      },
    })
    const { result } = renderHook(() => useThread())

    await expect(
      result.current.upload(new File(['FROM scratch'], 'Dockerfile')),
    ).rejects.toMatchObject({ status: 415, code: 'ATTACHMENT_UNSUPPORTED' })
    expect(client.upload).not.toHaveBeenCalled()
  })
})
