import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_IMPORT_WORKER_TIMEOUT_MS } from '@/services/chat-import/constants'
import {
  LOCAL_IMPORT_MAX_ARCHIVE_BYTES,
  LocalImportBackgroundProcessingUnavailableError,
  LocalImportWorkerTimeoutError,
  parseLocalTinfoilExportForAccess,
  PremiumProjectImportRequiredError,
  type LocalTinfoilImportOptions,
} from '@/services/chat-import/local-tinfoil-import'
import { createFunctionalImportWorker } from './functional-import-worker'

const options = {
  generateChatId: () => 'imported-chat',
}

// Every chat of an export, as an account with project access imports it.
const parseLocalTinfoilExport = async (
  file: File,
  parseOptions: LocalTinfoilImportOptions,
) => (await parseLocalTinfoilExportForAccess(file, parseOptions, true)).chats

function conversation(attachments?: unknown[]) {
  return [
    {
      uuid: 'original-chat',
      name: 'Portable chat',
      created_at: '2025-01-01T10:00:00.000Z',
      updated_at: '2025-01-01T11:00:00.000Z',
      chat_messages: [
        {
          uuid: 'message-1',
          text: 'Hello from another device',
          sender: 'human',
          created_at: '2025-01-01T10:00:00.000Z',
          attachments,
        },
      ],
    },
  ]
}

const FunctionalImportWorker = createFunctionalImportWorker()

interface ScriptedWorker {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: (() => void) | null
}

// Installs a worker that answers each request as `respond` scripts and
// records its termination.
function scriptWorker(respond: (worker: ScriptedWorker) => void) {
  const terminate = vi.fn()
  vi.stubGlobal(
    'Worker',
    class implements ScriptedWorker {
      onmessage: ScriptedWorker['onmessage'] = null
      onerror: ScriptedWorker['onerror'] = null
      onmessageerror: ScriptedWorker['onmessageerror'] = null

      postMessage() {
        queueMicrotask(() => respond(this))
      }

      terminate() {
        terminate()
      }
    },
  )
  return terminate
}

describe('parseLocalTinfoilExport', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FunctionalImportWorker)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('parses exports in a worker when workers are available', async () => {
    const postMessage = vi.fn()
    const terminate = vi.fn()
    const construct = vi.fn()
    class ImportWorker {
      constructor(url: URL) {
        construct(url)
      }
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null

      postMessage(message: unknown, transfer: Transferable[]) {
        postMessage(message, transfer)
        queueMicrotask(() => {
          this.onmessage?.({
            data: { ok: true, conversations: conversation() },
          } as MessageEvent)
        })
      }

      terminate() {
        terminate()
      }
    }
    vi.stubGlobal('Worker', ImportWorker)
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
      { type: 'application/json' },
    )

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(postMessage).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(construct).toHaveBeenCalledOnce()
    expect(construct.mock.calls[0][0].pathname).toMatch(
      /\/local-tinfoil-import\.worker\.ts$/,
    )
    const [request, transfer] = postMessage.mock.calls[0]
    expect(request).toEqual({
      buffer: expect.any(ArrayBuffer),
      fileName: file.name,
      mimeType: 'application/json',
      maxArchiveBytes: LOCAL_IMPORT_MAX_ARCHIVE_BYTES,
    })
    expect(new TextDecoder().decode(request.buffer)).toBe(
      JSON.stringify(conversation()),
    )
    expect(transfer).toHaveLength(1)
    expect(transfer[0]).toBe(request.buffer)
  })

  it('rejects malformed worker messages as unavailable background processing', async () => {
    const terminate = scriptWorker((worker) =>
      worker.onmessage?.({ data: null } as MessageEvent),
    )
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    await expect(parseLocalTinfoilExport(file, options)).rejects.toBeInstanceOf(
      LocalImportBackgroundProcessingUnavailableError,
    )
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('terminates timed-out workers without retrying on the main thread', async () => {
    vi.useFakeTimers()
    const terminate = scriptWorker(() => {})
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )
    const result = parseLocalTinfoilExport(file, options).catch(
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(LOCAL_IMPORT_WORKER_TIMEOUT_MS)

    expect(await result).toBeInstanceOf(LocalImportWorkerTimeoutError)
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('fails explicitly when a worker response cannot deserialize', async () => {
    const terminate = scriptWorker((worker) => worker.onmessageerror?.())
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    await expect(parseLocalTinfoilExport(file, options)).rejects.toBeInstanceOf(
      LocalImportBackgroundProcessingUnavailableError,
    )
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('fails explicitly when a worker cannot start', async () => {
    class UnavailableWorker {
      constructor() {
        throw new DOMException('Unavailable', 'NotSupportedError')
      }
    }
    vi.stubGlobal('Worker', UnavailableWorker)
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    await expect(parseLocalTinfoilExport(file, options)).rejects.toBeInstanceOf(
      LocalImportBackgroundProcessingUnavailableError,
    )
  })

  it('fails explicitly when worker execution errors', async () => {
    scriptWorker((worker) =>
      worker.onerror?.(new ErrorEvent('error', { message: 'worker failed' })),
    )
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    await expect(parseLocalTinfoilExport(file, options)).rejects.toBeInstanceOf(
      LocalImportBackgroundProcessingUnavailableError,
    )
  })

  it('preserves parser errors returned by a running worker', async () => {
    scriptWorker((worker) =>
      worker.onmessage?.({
        data: { ok: false, error: 'The export archive is malformed' },
      } as MessageEvent),
    )
    const file = new File(['not-json'], 'conversations.json')

    await expect(parseLocalTinfoilExport(file, options)).rejects.toThrow(
      'The export archive is malformed',
    )
  })

  it('imports the chats of conversations.json', async () => {
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({
      id: 'imported-chat',
      title: 'Portable chat',
      updatedAt: '2025-01-01T11:00:00.000Z',
    })
    expect(chats[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'Hello from another device',
    })
  })

  it('drops project associations that local import cannot restore', async () => {
    const data = conversation()
    ;(data[0] as Record<string, unknown>).projectId = 'project-123'
    const file = new File([JSON.stringify(data)], 'conversations.json')

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0].projectId).toBeUndefined()
  })

  it('keeps attachment-only messages with empty text', async () => {
    const data = conversation([
      {
        id: 'doc-1',
        type: 'document',
        fileName: 'notes.md',
        textContent: 'Attached notes',
      },
    ])
    data[0].chat_messages[0].text = ''
    const file = new File([JSON.stringify(data)], 'conversations.json')

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0].messages).toHaveLength(1)
    expect(chats[0].messages[0].content).toBe('')
    expect(chats[0].messages[0].attachments).toMatchObject([
      { id: 'doc-1', type: 'document', fileName: 'notes.md' },
    ])
  })

  it('restores attachment bytes from a Tinfoil ZIP export', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4])
    const archive = zipSync({
      'conversations.json': strToU8(
        JSON.stringify(
          conversation([
            {
              id: 'image-1',
              type: 'image',
              fileName: 'photo.png',
              mimeType: 'image/png',
              exportPath: 'attachments/image-1/photo.png',
            },
          ]),
        ),
      ),
      'attachments/image-1/photo.png': imageBytes,
    })
    const file = new File([archive], 'tinfoil-chats.zip', {
      type: 'application/zip',
    })

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats[0].messages[0].attachments).toEqual([
      {
        id: 'image-1',
        type: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 4,
        textContent: undefined,
        base64: 'AQIDBA==',
      },
    ])
  })

  it('imports ordinary chats and reports skipped project chats from mixed archives', async () => {
    const data = [
      ...conversation(),
      {
        ...conversation()[0],
        uuid: 'project-chat',
        name: 'Project chat',
        projectId: 'project-123',
      },
    ]
    const archive = zipSync({
      'conversations.json': strToU8(JSON.stringify(data)),
    })
    const file = new File([archive], 'mixed-tinfoil-chats.zip', {
      type: 'application/zip',
    })

    const result = await parseLocalTinfoilExportForAccess(file, options, false)

    expect(result.chats.map((chat) => chat.title)).toEqual(['Portable chat'])
    expect(result.skippedProjectChats).toBe(1)
  })

  it('returns a clear Premium error for project-only archives', async () => {
    const data = conversation()
    ;(data[0] as Record<string, unknown>).projectId = 'project-123'
    const archive = zipSync({
      'conversations.json': strToU8(JSON.stringify(data)),
    })
    const file = new File([archive], 'project-chats.zip', {
      type: 'application/zip',
    })

    const result = parseLocalTinfoilExportForAccess(file, options, false)

    await expect(result).rejects.toEqual(
      expect.any(PremiumProjectImportRequiredError),
    )
    await expect(result).rejects.toThrow(
      'This backup contains only project chats. Premium is required to import it.',
    )
  })

  it('ignores empty project conversations without requiring Premium', async () => {
    const data = conversation()
    ;(data[0] as Record<string, unknown>).projectId = 'project-123'
    ;(data[0] as Record<string, unknown>).chat_messages = [
      {
        uuid: 'empty-message',
        text: '   ',
        sender: 'human',
        created_at: '2025-01-01T10:00:00.000Z',
        attachments: [],
      },
    ]
    const archive = zipSync({
      'conversations.json': strToU8(JSON.stringify(data)),
    })
    const file = new File([archive], 'empty-project-chats.zip', {
      type: 'application/zip',
    })

    await expect(
      parseLocalTinfoilExportForAccess(file, options, false),
    ).resolves.toEqual({ chats: [], skippedProjectChats: 0 })
  })

  it('rejects ZIP exports with missing attachment entries', async () => {
    const archive = zipSync({
      'conversations.json': strToU8(
        JSON.stringify(
          conversation([
            {
              id: 'image-1',
              type: 'image',
              fileName: 'photo.png',
              exportPath: 'attachments/image-1/photo.png',
            },
          ]),
        ),
      ),
    })
    const file = new File([archive], 'tinfoil-chats.zip', {
      type: 'application/zip',
    })

    await expect(parseLocalTinfoilExport(file, options)).rejects.toThrow(
      'The export is missing attachments/image-1/photo.png',
    )
  })
})
