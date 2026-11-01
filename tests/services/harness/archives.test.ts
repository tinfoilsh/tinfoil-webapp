import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  ImportSequenceError,
  runImports,
  type ImportStatusResponse,
} from '@/services/harness/archives'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'Y29udGVudC1rZXk='

// The sync service runs one import per account, so the order of uploads and
// status polls is the contract under test.
let events: string[]
let jobs: number
let statuses: Record<string, (ImportStatusResponse | Error)[]>
let upload: ReturnType<typeof vi.fn>
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

beforeEach(() => {
  events = []
  jobs = 0
  statuses = {}
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  upload = vi.fn(async (_path: string, file: File) => {
    jobs++
    events.push(`upload ${file.name} as job-${jobs}`)
    return { jobId: `job-${jobs}` }
  })
  const client = {
    upload,
    post: vi.fn(async (path: string, input: { jobId: string }) => {
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
    }),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
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
      'chatgpt',
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
    expect(upload.mock.calls.map(([path, , fields]) => [path, fields])).toEqual(
      [
        ['/v1/import', { key: KEY, source: 'chatgpt' }],
        ['/v1/import', { key: KEY, source: 'chatgpt' }],
        ['/v1/import', { key: KEY, source: 'chatgpt' }],
      ],
    )
    expect(result).toEqual({
      status: { ...job('running'), jobId: 'job-3' },
      fileIndex: 2,
      importedBefore: 7,
      interrupted: false,
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
      'chatgpt',
      [namedFile('user.json'), namedFile('conversations-000.json')],
      { wait: noWait },
    )

    expect(events).toEqual(['upload user.json as job-1', 'status job-1 failed'])
    expect(result).toEqual({
      status: { ...failed, jobId: 'job-1' },
      fileIndex: 0,
      importedBefore: 0,
      interrupted: false,
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
      'claude',
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
      importedBefore: 0,
      interrupted: true,
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
      'chatgpt',
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
    expect(result).toMatchObject({ fileIndex: 1, importedBefore: 5 })
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
      'chatgpt',
      [
        namedFile('conversations-000.json'),
        namedFile('conversations-001.json'),
      ],
      { wait: noWait },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ImportSequenceError)
    expect(error).toMatchObject({ fileIndex: 0, importedBefore: 0 })
    expect((error as Error).cause).toBe(unreachable)
    expect(upload).toHaveBeenCalledOnce()
  })

  it('keeps the chats earlier files imported when a later file cannot start', async () => {
    statuses = { 'job-1': [job('completed', 4)] }
    const busy = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'an import is already in progress' },
      409,
    )
    upload
      .mockImplementationOnce(async () => {
        jobs++
        return { jobId: 'job-1' }
      })
      .mockRejectedValueOnce(busy)

    const error = await runImports(
      'chatgpt',
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
      importedBefore: 4,
    })
    expect((error as Error).cause).toBe(busy)
  })
})
