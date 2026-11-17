import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type {
  AttachmentDescriptor,
  Frame,
  Thread,
  Turn,
} from '@/services/harness/types'
import { useThread, type ThreadRoute } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
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
  activityAt: '2026-04-01T09:00:00Z',
  model: 'test-model',
  projectId: null,
  presetId: null,
  pinned: false,
  webSearchEnabled: true,
  contextUsage: null,
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

  it('shows each attachment by its name, type, size and thumbnail', async () => {
    const { result } = await openStored()

    expect(result.current.chat.messages[0].attachments).toEqual([
      {
        id: 'att_report',
        type: 'document',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSize: 2048,
      },
      {
        id: 'att_chart',
        type: 'image',
        fileName: 'chart.png',
        mimeType: 'image/png',
        fileSize: 512,
        thumbnailBase64: 'dGh1bWI=',
      },
    ])
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
        new HarnessError({
          code: 'UPSTREAM_REFUSED',
          message: 'offline',
          action: 'retry',
        }),
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
  // reads if it is. The chat is one the harness stores, so every file but
  // an image uploads with the content key.
  it.each([
    { name: 'photo.png', size: 1000, refused: null, fields: {} },
    {
      name: 'PHOTO.PNG',
      size: 1001,
      refused: 413,
      message: 'File size exceeds the limit of 1000 B.',
    },
    { name: 'notes.v2.txt', size: 2000, refused: null, fields: { key: KEY } },
    {
      name: 'notes.txt',
      size: 2001,
      refused: 413,
      message: 'Text file exceeds the limit of 2.0 KB.',
    },
    { name: 'Dockerfile', size: 2000, refused: null, fields: { key: KEY } },
    {
      name: 'archive.zip',
      size: 2001,
      refused: 413,
      message: 'Text file exceeds the limit of 2.0 KB.',
    },
  ])(
    'uploads $name of $size bytes unless its group refuses it ($refused)',
    async ({ name, size, refused, message, fields }) => {
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
          fields,
          expect.any(AbortSignal),
        )
      } else {
        await expect(upload).rejects.toMatchObject({
          status: refused,
          code:
            refused === 413 ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_UNSUPPORTED',
          message,
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

// A document as an upload with the content key returns it: with where the
// harness kept the file as it was uploaded.
const report: AttachmentDescriptor = {
  id: 'att_report',
  kind: 'document',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  size: 8,
  textContent: 'Revenue grew.',
  original: {
    id: 'att_0123456789abcdef',
    encryptionKey: 'b3JpZ2luYWwtZmlsZS1rZXk=',
    storageThreadId: 'upload_0123456789abcdef',
  },
}
const { original: _original, ...reportWithoutOriginal } = report

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// A run that starts, and ends once `ended` does.
const runUntil = (ended: Promise<void>) =>
  async function* (_path: string, input: Turn): AsyncGenerator<Frame> {
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: input.threadId!,
        runId: `run-${input.clientRequestId}`,
        instance: 'instance-1',
      },
    }
    await ended
    yield {
      id: 1,
      event: {
        type: 'RUN_FINISHED',
        threadId: input.threadId!,
        runId: `run-${input.clientRequestId}`,
        metadata: {},
      },
    }
  }

describe('keeping a file as it was uploaded', () => {
  it.each<{
    chat: string
    account?: Parameters<typeof signIn>[0]
    route?: ThreadRoute
    temporary?: boolean
    fields: Record<string, string>
  }>([
    { chat: 'a stored chat', fields: { key: KEY } },
    {
      chat: 'a chat kept on this device beside stored ones',
      route: { newChatLocal: true },
      fields: {},
    },
    { chat: 'a temporary chat', temporary: true, fields: {} },
    {
      chat: 'a chat of an account without cloud sync',
      account: { cloud: false },
      fields: {},
    },
    {
      chat: 'a chat of a signed-out visitor',
      account: { userId: null },
      fields: {},
    },
    {
      chat: 'a stored chat whose content key is locked',
      account: { cloud: true, locked: true },
      fields: {},
    },
  ])(
    'uploads a document for $chat with $fields',
    async ({ account = { cloud: true }, route, temporary, fields }) => {
      signIn(account)
      client.upload.mockResolvedValue({ attachment: reportWithoutOriginal })
      const { result } = renderHook(() => useThread(null, null, route))
      if (temporary) act(() => result.current.setTemporary(true))
      const picked = new File(['%PDF-1.7'], 'report.pdf')

      await result.current.upload(picked)

      expect(client.upload).toHaveBeenCalledExactlyOnceWith(
        '/v1/attachments/upload',
        picked,
        fields,
        expect.any(AbortSignal),
      )
    },
  )

  it('uploads an image for a stored chat without the content key', async () => {
    signIn({ cloud: true })
    client.upload.mockResolvedValue({
      attachment: {
        id: 'att_photo',
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        base64: 'bW9kZWwtY29weQ==',
      },
    })
    const { result } = renderHook(() => useThread())
    const picked = new File([new Uint8Array(4)], 'photo.png', {
      type: 'image/png',
    })

    await result.current.upload(picked)

    expect(client.upload).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/upload',
      expect.any(File),
      {},
      expect.any(AbortSignal),
    )
  })

  it('sends where the harness kept a file back with the turns that attach it', async () => {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    client.upload.mockResolvedValue({ attachment: report })
    const replied = gate()
    client.events.mockImplementation(runUntil(replied.promise))
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.loadingChats).toBe(false))
    const uploaded = await result.current.upload(
      new File(['%PDF-1.7'], 'report.pdf'),
    )
    expect(uploaded).toEqual(report)

    try {
      // The turn that attaches the file, while no reply runs.
      act(() => {
        void result.current.send({
          content: 'Summarize this',
          attachments: [uploaded],
        })
      })
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      // A turn queued behind the running reply.
      act(() => {
        void result.current.send({
          content: 'And this copy',
          attachments: [{ ...uploaded, id: 'att_copy' }],
        })
      })
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
    } finally {
      await act(async () => replied.resolve())
    }
    await waitFor(() => expect(result.current.status).toBe('idle'))
    // An edit that sends the upload again.
    await act(async () => {
      await result.current.send({
        kind: 'edit',
        messageId: turn(0).clientRequestId,
        content: 'Summarize this briefly',
        attachments: [uploaded],
      })
    })

    expect(client.events).toHaveBeenCalledTimes(3)
    expect(
      [0, 1, 2].map((call) => ({
        kind: turn(call).kind,
        key: turn(call).key,
        attachments: turn(call).attachments,
      })),
    ).toStrictEqual([
      { kind: 'send', key: KEY, attachments: [report] },
      {
        kind: 'send',
        key: KEY,
        attachments: [{ ...report, id: 'att_copy' }],
      },
      { kind: 'edit', key: KEY, attachments: [report] },
    ])
  })

  it('leaves where the harness kept a file out of a chat this device keeps', async () => {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    const replied = gate()
    client.events.mockImplementation(runUntil(replied.promise))
    const { result } = renderHook(() =>
      useThread(null, null, { newChatLocal: true }),
    )
    await waitFor(() => expect(result.current.loadingChats).toBe(false))

    try {
      // The file was uploaded for a stored chat before the chat became one
      // this device keeps.
      act(() => {
        void result.current.send({
          content: 'Summarize this',
          attachments: [report],
        })
      })
      await waitFor(() => expect(client.events).toHaveBeenCalledOnce())

      expect(turn().local).toBe(true)
      expect(turn().key).toBeUndefined()
      expect(turn().attachments).toStrictEqual([reportWithoutOriginal])
      const threadId = turn().threadId!
      await waitFor(async () =>
        expect(
          (await localThreadStore('device').get(threadId))?.messages,
        ).toHaveLength(1),
      )
      expect(
        (await localThreadStore('device').get(threadId))?.messages[0]
          .attachments,
      ).toStrictEqual([reportWithoutOriginal])
    } finally {
      await act(async () => replied.resolve())
    }
  })
})
