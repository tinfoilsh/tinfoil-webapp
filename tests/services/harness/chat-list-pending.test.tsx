import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { chatEvents } from '@/services/storage/chat-events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
resetChatStoresAroundEachTest()

function summary(
  id: string,
  activityAt: string,
  fields: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id,
    title: id,
    titleState: 'generated',
    model: 'gpt-oss-120b',
    createdAt: activityAt,
    updatedAt: activityAt,
    activityAt,
    projectId: null,
    pinned: false,
    webSearchEnabled: true,
    contextUsage: null,
    messageCount: 2,
    activeRun: null,
    ...fields,
  }
}

type Page = {
  threads: ThreadSummary[]
  pinned: ThreadSummary[]
  nextCursor: null
}
const page = (threads: ThreadSummary[], pinned: ThreadSummary[] = []) => ({
  threads,
  pinned,
  nextCursor: null,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const unreachable = () =>
  new HarnessError({
    code: 'CONNECTION',
    action: 'retry',
    message: 'The chat service could not be reached.',
  })

type Hook = { current: ReturnType<typeof useThread> }
const listed = (result: Hook) =>
  result.current.chats.map(({ id, title }) => ({ id, title }))

const doomed = summary('doomed', '2026-10-22T12:00:00Z')
const kept = summary('kept', '2026-10-21T12:00:00Z')

// Lists `first`, then holds every later listing until the test answers it,
// and holds each change of a chat until the test answers it.
function listThenHold(first: ThreadSummary[], pinned: ThreadSummary[] = []) {
  signIn({ cloud: true })
  const listings: ReturnType<typeof deferred<Page>>[] = []
  const changes: {
    path: string
    input: unknown
    answer: ReturnType<typeof deferred<unknown>>
  }[] = []
  client.post.mockImplementation(async (path: string, input: unknown) => {
    if (path === '/v1/threads/list') {
      if (!listings.length) {
        listings.push(deferred<Page>())
        return page(first, pinned)
      }
      const listing = deferred<Page>()
      listings.push(listing)
      return listing.promise
    }
    if (path === '/v1/threads/delete' || path === '/v1/threads/update') {
      const answer = deferred<unknown>()
      changes.push({ path, input, answer })
      return answer.promise
    }
    throw new Error(`Unexpected ${path}`)
  })
  const hook = renderHook(() => useThread())
  return { ...hook, listings, changes }
}

// Reads the stored chats again, and holds the listing for the test to
// answer.
function readAgain(
  result: Hook,
  listings: ReturnType<typeof deferred<Page>>[],
) {
  let reading!: Promise<void>
  act(() => {
    reading = result.current.refresh()
  })
  const listing = listings.at(-1)!
  return (answer: Page) =>
    act(async () => {
      listing.resolve(answer)
      await reading
    })
}

describe('a stored chat deleted while the list is read again', () => {
  it.each(['deleted', 'refused'] as const)(
    'stays out of the list the read answers with, until it is %s',
    async (outcome) => {
      const { result, listings, changes } = listThenHold([doomed, kept])
      await waitFor(() =>
        expect(listed(result)).toEqual([
          { id: 'doomed', title: 'doomed' },
          { id: 'kept', title: 'kept' },
        ]),
      )
      const answerRead = readAgain(result, listings)
      let removing!: Promise<void>
      act(() => {
        removing = result.current.remove(doomed.id)
      })
      await waitFor(() =>
        expect(changes.map(({ path, input }) => [path, input])).toEqual([
          ['/v1/threads/delete', { key: KEY, id: doomed.id }],
        ]),
      )
      expect(listed(result)).toEqual([{ id: 'kept', title: 'kept' }])

      await answerRead(page([{ ...doomed, title: 'Renamed elsewhere' }, kept]))
      expect(listed(result)).toEqual([{ id: 'kept', title: 'kept' }])

      await act(async () => {
        if (outcome === 'deleted') changes[0].answer.resolve({})
        else changes[0].answer.reject(unreachable())
        await removing.catch(() => {})
      })
      // A chat the harness kept is listed again as the list last read it.
      expect(listed(result)).toEqual(
        outcome === 'deleted'
          ? [{ id: 'kept', title: 'kept' }]
          : [
              { id: 'doomed', title: 'Renamed elsewhere' },
              { id: 'kept', title: 'kept' },
            ],
      )
    },
  )

  it('stays out of the favorites when it is deleted before its pin is answered', async () => {
    const { result, changes } = listThenHold([doomed, kept])
    await waitFor(() => expect(result.current.chats).toHaveLength(2))
    let pinning!: Promise<unknown>
    act(() => {
      pinning = result.current.update(doomed.id, { pinned: true })
    })
    expect(result.current.favoriteIds).toEqual([doomed.id])
    let removing!: Promise<void>
    act(() => {
      removing = result.current.remove(doomed.id)
    })
    await waitFor(() =>
      expect(changes.map(({ path }) => path)).toEqual([
        '/v1/threads/update',
        '/v1/threads/delete',
      ]),
    )

    await act(async () => {
      changes[1].answer.resolve({})
      await removing
    })
    expect(result.current.favoriteIds).toEqual([])

    // The harness pinned the chat before it deleted it.
    await act(async () => {
      changes[0].answer.resolve({ ...doomed, pinned: true })
      await pinning
    })
    expect(result.current.favoriteIds).toEqual([])
    expect(listed(result)).toEqual([{ id: 'kept', title: 'kept' }])
  })

  it('stays out of the list a reload restores while its deletion saves', async () => {
    const first = listThenHold([doomed, kept])
    await waitFor(() => expect(first.result.current.chats).toHaveLength(2))
    act(() => {
      void first.result.current.remove(doomed.id)
      void first.result.current.update(kept.id, { title: 'Kept for later' })
    })
    await waitFor(() => expect(first.changes).toHaveLength(2))
    first.unmount()

    signIn({ cloud: true })
    const fresh = deferred<Page>()
    client.post.mockReturnValue(fresh.promise)
    const reloaded = renderHook(() => useThread())
    expect(listed(reloaded.result)).toEqual([
      { id: 'kept', title: 'Kept for later' },
    ])
    await act(async () => fresh.resolve(page([kept])))
  })
})

describe('a stored chat renamed while the list is read again', () => {
  it.each(['saved', 'refused'] as const)(
    'keeps its new title over the read, until it is %s',
    async (outcome) => {
      const { result, listings, changes } = listThenHold([doomed, kept])
      await waitFor(() => expect(result.current.chats).toHaveLength(2))
      const answerRead = readAgain(result, listings)
      let renaming!: Promise<unknown>
      act(() => {
        renaming = result.current.update(kept.id, { title: 'New title' })
      })

      await answerRead(page([doomed, kept]))
      expect(listed(result)).toEqual([
        { id: 'doomed', title: 'doomed' },
        { id: 'kept', title: 'New title' },
      ])

      await act(async () => {
        if (outcome === 'saved')
          changes[0].answer.resolve({
            ...kept,
            title: 'New title',
            titleState: 'manual',
          })
        else changes[0].answer.reject(unreachable())
        await renaming.catch(() => {})
      })
      expect(listed(result)).toEqual([
        { id: 'doomed', title: 'doomed' },
        { id: 'kept', title: outcome === 'saved' ? 'New title' : 'kept' },
      ])
    },
  )

  it('keeps it among the favorites over the read while its pin saves', async () => {
    const { result, listings, changes } = listThenHold([doomed, kept])
    await waitFor(() => expect(result.current.chats).toHaveLength(2))
    const answerRead = readAgain(result, listings)
    let pinning!: Promise<unknown>
    act(() => {
      pinning = result.current.update(kept.id, { pinned: true })
    })
    expect(result.current.favoriteIds).toEqual([kept.id])

    await answerRead(page([doomed, kept]))
    expect(result.current.favoriteIds).toEqual([kept.id])

    await act(async () => {
      changes[0].answer.reject(unreachable())
      await pinning.catch(() => {})
    })
    expect(result.current.favoriteIds).toEqual([])
  })

  it('shows the later of two renames once it is saved, while the earlier is still saving', async () => {
    const { result, changes } = listThenHold([kept])
    await waitFor(() => expect(result.current.chats).toHaveLength(1))
    const renames: Promise<unknown>[] = []
    act(() => {
      renames.push(result.current.update(kept.id, { title: 'First' }))
      renames.push(result.current.update(kept.id, { title: 'Second' }))
    })

    await act(async () => {
      changes[1].answer.resolve({
        ...kept,
        title: 'Second',
        titleState: 'manual',
      })
      await renames[1]
    })
    expect(listed(result)).toEqual([{ id: 'kept', title: 'Second' }])

    await act(async () => {
      changes[0].answer.resolve({
        ...kept,
        title: 'First',
        titleState: 'manual',
      })
      await renames[0]
    })
    expect(listed(result)).toEqual([{ id: 'kept', title: 'Second' }])
  })

  it.each(['the earlier is saved first', 'the later is refused first'])(
    'lists the earlier of two renames the harness saved when the later is refused, as %s',
    async (order) => {
      const { result, changes } = listThenHold([kept])
      await waitFor(() => expect(result.current.chats).toHaveLength(1))
      const renames: Promise<unknown>[] = []
      act(() => {
        renames.push(result.current.update(kept.id, { title: 'First' }))
        renames.push(result.current.update(kept.id, { title: 'Second' }))
      })
      const save = () =>
        act(async () => {
          changes[0].answer.resolve({
            ...kept,
            title: 'First',
            titleState: 'manual',
          })
          await renames[0]
        })
      const refuse = () =>
        act(async () => {
          changes[1].answer.reject(unreachable())
          await renames[1].catch(() => {})
        })

      if (order === 'the earlier is saved first') {
        await save()
        await refuse()
      } else {
        await refuse()
        await save()
      }

      expect(listed(result)).toEqual([{ id: 'kept', title: 'First' }])
    },
  )
})

describe('a chat on this device renamed while the device is read again', () => {
  const CHAT_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
  const onDevice = storedThread(CHAT_ID, {
    title: 'Old title',
    titleState: 'generated',
    messages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: '2026-04-01T09:00:00Z',
        content: 'Hello',
      },
    ],
  })

  async function renameHeld() {
    signIn()
    await localThreadStore('device').add(onDevice)
    const answer = deferred<unknown>()
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/update') return answer.promise
      throw new Error(`Unexpected ${path}`)
    })
    const hook = renderHook(() => useThread())
    await waitFor(() =>
      expect(listed(hook.result)).toEqual([
        { id: CHAT_ID, title: 'Old title' },
      ]),
    )
    let renaming!: Promise<unknown>
    act(() => {
      renaming = hook.result.current.update(CHAT_ID, { title: 'New title' })
    })
    await waitFor(() => expect(client.post).toHaveBeenCalledOnce())
    return { ...hook, answer, renaming: () => renaming }
  }

  it('keeps its new title over what the device holds until it is saved', async () => {
    const { result } = await renameHeld()
    const read = vi.spyOn(localThreadStore('device'), 'list')

    act(() => chatEvents.emit({ reason: 'sync', ids: [] }))
    expect(read).toHaveBeenCalledOnce()
    await act(() => read.mock.results[0].value)

    expect(listed(result)).toEqual([{ id: CHAT_ID, title: 'New title' }])
  })

  it('lists the title it was saved with before the device is read again', async () => {
    const { result, answer, renaming } = await renameHeld()
    const reading = deferred<ThreadSummary[]>()
    const read = vi
      .spyOn(localThreadStore('device'), 'list')
      .mockReturnValue(reading.promise)

    await act(async () => {
      answer.resolve({
        thread: { ...onDevice, title: 'New title', titleState: 'manual' },
      })
      await renaming()
    })

    expect(read).toHaveBeenCalled()
    expect(listed(result)).toEqual([{ id: CHAT_ID, title: 'New title' }])
  })
})
