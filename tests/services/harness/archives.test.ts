import {
  ImportSequenceError,
  runImports,
  type ImportStatusResponse,
} from '@/services/harness/archives'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { StoredThread } from '@/services/harness/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

// The sync service runs one import per account, so the order of uploads and
// status polls is the contract under test.
let events: string[]
// The device chats each upload returns before its last line.
let deviceChats: Record<string, StoredThread[]>
let jobs: number
let statuses: Record<string, (ImportStatusResponse | Error)[]>
const noWait = async () => {}

function namedFile(name: string): File {
  return new File([new TextEncoder().encode(`[${name}]`)], name, {
    type: 'application/json',
  })
}

function job(
  status: ImportStatusResponse['status'],
  imported = 0,
  extra: Partial<ImportStatusResponse> = {},
): ImportStatusResponse {
  return { status, imported, failed: 0, total: imported, errors: [], ...extra }
}

// An import's response: a line per chat for this device, then the last line.
function importResponse(threads: StoredThread[], done: object) {
  return new Response(
    [...threads.map((thread) => ({ thread })), { done }]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  )
}

// The options and file name of each import request.
const importRequests = () =>
  (client.multipart.mock.calls as [string, FormData][]).map(([path, form]) => [
    path,
    JSON.parse(form.get('options') as string),
    (form.get('file') as File).name,
  ])

resetChatStoresAroundEachTest()

beforeEach(() => {
  events = []
  jobs = 0
  statuses = {}
  deviceChats = {}
  signIn()
  client.multipart.mockImplementation(async (_path: string, form: FormData) => {
    const file = form.get('file') as File
    const { target } = JSON.parse(form.get('options') as string)
    const threads = deviceChats[file.name] ?? []
    if (target === 'device') {
      events.push(`upload ${file.name} for this device`)
      return importResponse(threads, { jobId: null, warnings: [] })
    }
    jobs++
    events.push(`upload ${file.name} as job-${jobs}`)
    return importResponse(threads, {
      jobId: `job-${jobs}`,
      warnings: [`${file.name} had a note`],
    })
  })
  client.post.mockImplementation(
    async (path: string, input: { jobId: string }) => {
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      const { jobId } = input
      // The first status after an upload is the kickoff snapshot.
      const next = statuses[jobId]?.shift() ?? job('running')
      if (next instanceof Error) {
        events.push(`status ${jobId} error`)
        throw next
      }
      events.push(`status ${jobId} ${next.status}`)
      return next
    },
  )
})

describe('runImports', () => {
  it('finishes each file before uploading the next and leaves the last running', async () => {
    statuses = {
      'job-1': [job('running'), job('running', 1), job('completed', 4)],
      'job-2': [job('completed', 3)],
      'job-3': [job('running')],
    }
    const onProcessing = vi.fn()
    const onUpload = vi.fn()

    const result = await runImports(
      'cloud',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
        namedFile('conversations-002.json'),
      ],
      { wait: noWait, onProcessing, onUpload },
    )

    expect(events).toEqual([
      'upload conversations-000.json as job-1',
      'status job-1 running',
      'status job-1 running',
      'status job-1 completed',
      'upload conversations-001.json as job-2',
      'status job-2 completed',
      'upload conversations-002.json as job-3',
      'status job-3 running',
    ])
    expect(importRequests()).toEqual([
      ['/v1/import', { target: 'cloud', key: KEY }, 'conversations-000.json'],
      ['/v1/import', { target: 'cloud', key: KEY }, 'conversations-001.json'],
      ['/v1/import', { target: 'cloud', key: KEY }, 'conversations-002.json'],
    ])
    expect(result).toEqual({
      status: { ...job('running'), jobId: 'job-3' },
      fileIndex: 2,
      imported: 7,
      interrupted: false,
      warnings: [
        'conversations-000.json had a note',
        'conversations-001.json had a note',
        'conversations-002.json had a note',
      ],
    })
    expect(onUpload.mock.calls).toEqual([[0], [1], [2]])
    expect(
      onProcessing.mock.calls.map(([index, status]) => [index, status.status]),
    ).toEqual([
      [0, 'running'],
      [0, 'running'],
      [0, 'completed'],
    ])
  })

  it('stops at the first file that fails', async () => {
    const failed = job('failed', 0, {
      failure_reason: 'invalid_archive',
      failure_detail: 'unexpected_json',
    })
    statuses = { 'job-1': [failed] }

    const result = await runImports(
      'cloud',
      [namedFile('user.json'), namedFile('conversations-000.json')],
      { wait: noWait },
    )

    expect(events).toEqual(['upload user.json as job-1', 'status job-1 failed'])
    expect(result).toEqual({
      status: { ...failed, jobId: 'job-1' },
      fileIndex: 0,
      imported: 0,
      interrupted: false,
      warnings: ['user.json had a note'],
    })
  })

  it('reports a job that was lost as interrupted without starting the next', async () => {
    statuses = {
      'job-1': [
        job('running', 2),
        new HarnessError(
          { code: 'THREAD_NOT_FOUND', message: 'not found' },
          404,
        ),
      ],
    }

    const result = await runImports(
      'cloud',
      [namedFile('conversations.json'), namedFile('projects.json')],
      { wait: noWait },
    )

    expect(events).toEqual([
      'upload conversations.json as job-1',
      'status job-1 running',
      'status job-1 error',
    ])
    expect(result).toEqual({
      status: { ...job('running', 2), jobId: 'job-1' },
      fileIndex: 0,
      imported: 0,
      interrupted: true,
      warnings: ['conversations.json had a note'],
    })
  })

  it('keeps waiting through a transient status failure', async () => {
    statuses = {
      'job-1': [
        job('running'),
        new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'busy' }, 502),
        job('partial', 5),
      ],
    }

    const result = await runImports(
      'cloud',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    )

    expect(events).toEqual([
      'upload conversations-000.json as job-1',
      'status job-1 running',
      'status job-1 error',
      'status job-1 partial',
      'upload conversations-001.json as job-2',
      'status job-2 running',
    ])
    expect(result).toMatchObject({ fileIndex: 1, imported: 5 })
  })

  it('gives up once the service stays unreachable instead of starting the next file', async () => {
    const unreachable = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'bad gateway' },
      502,
    )
    statuses = {
      'job-1': [
        job('running'),
        ...Array.from({ length: 5 }, () => unreachable),
      ],
    }

    const error = await runImports(
      'cloud',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ImportSequenceError)
    expect(error).toMatchObject({ fileIndex: 0, imported: 0 })
    expect((error as Error).cause).toBe(unreachable)
    expect(client.multipart).toHaveBeenCalledOnce()
  })

  it('keeps the chats earlier files imported when a later file cannot start', async () => {
    statuses = { 'job-1': [job('completed', 4)] }
    const busy = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'an import is already in progress' },
      409,
    )
    client.multipart
      .mockImplementationOnce(async () => {
        jobs++
        return importResponse([], { jobId: 'job-1', warnings: [] })
      })
      .mockRejectedValueOnce(busy)

    const error = await runImports(
      'cloud',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
        namedFile('conversations-002.json'),
      ],
      { wait: noWait },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ImportSequenceError)
    expect(error).toMatchObject({
      message: 'an import is already in progress',
      fileIndex: 1,
      imported: 4,
    })
    expect((error as Error).cause).toBe(busy)
  })

  it('stores the chats every file returns for this device without polling a job', async () => {
    const plants = storedThread('import_plants', { title: 'Plants' })
    const soup = storedThread('import_soup', { title: 'Soup' })
    deviceChats = {
      'conversations-000.json': [plants],
      'conversations-001.json': [soup],
    }

    const result = await runImports(
      'device',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    )

    expect(events).toEqual([
      'upload conversations-000.json for this device',
      'upload conversations-001.json for this device',
    ])
    expect(importRequests().map(([, options]) => options)).toEqual([
      { target: 'device' },
      { target: 'device' },
    ])
    expect(result).toEqual({
      status: null,
      fileIndex: 1,
      imported: 2,
      interrupted: false,
      warnings: [],
    })
    expect(await localThreadStore('device').get(plants.id)).toEqual(plants)
    expect(await localThreadStore('device').get(soup.id)).toEqual(soup)
  })

  it('fails a file whose response ends before its last line, keeping the chats it stored', async () => {
    const plants = storedThread('import_plants', { title: 'Plants' })
    client.multipart.mockResolvedValue(
      new Response(`${JSON.stringify({ thread: plants })}\n`),
    )

    const error = await runImports(
      'device',
      [namedFile('conversations.json')],
      {
        wait: noWait,
      },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ImportSequenceError)
    expect((error as ImportSequenceError).cause).toMatchObject({
      code: 'STREAM_INTERRUPTED',
    })
    expect(await localThreadStore('device').get(plants.id)).toEqual(plants)
  })
})
