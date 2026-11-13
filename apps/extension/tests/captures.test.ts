import { renderHook, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { useStoredCaptures } from '../src/captures'
import { TaskStore } from '../src/storage'

const stores: TaskStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

const source = (image: string) => `data:image/jpeg;base64,${image}`

test('a chat reads each picture it lists once, as it comes to list it, and none of another chat', async () => {
  const store = new TaskStore(crypto.randomUUID())
  stores.push(store)
  await store.putCapture('alice', 'task', 'first', 'Zmlyc3Q=')
  await store.putCapture('alice', 'other', 'first', 'b3RoZXI=')
  const read = vi.spyOn(store, 'capture')
  const hook = renderHook(
    ({ taskId, listed }: { taskId?: string; listed: string[] }) =>
      useStoredCaptures(store, 'alice', taskId, listed),
    {
      initialProps: { taskId: 'task', listed: ['first'] } as {
        taskId?: string
        listed: string[]
      },
    },
  )
  expect(hook.result.current).toEqual(new Map())
  await waitFor(() =>
    expect(hook.result.current).toEqual(
      new Map([['first', source('Zmlyc3Q=')]]),
    ),
  )

  await store.putCapture('alice', 'task', 'second', 'c2Vjb25k')
  hook.rerender({ taskId: 'task', listed: ['first', 'second'] })
  await waitFor(() =>
    expect(hook.result.current).toEqual(
      new Map([
        ['first', source('Zmlyc3Q=')],
        ['second', source('c2Vjb25k')],
      ]),
    ),
  )
  expect(read.mock.calls).toEqual([
    ['alice', 'task', 'first'],
    ['alice', 'task', 'second'],
  ])

  // Another chat's call of the same id has its own picture, and shows none
  // of the first chat's while it is read.
  hook.rerender({ taskId: 'other', listed: ['first'] })
  expect(hook.result.current).toEqual(new Map())
  await waitFor(() =>
    expect(hook.result.current).toEqual(
      new Map([['first', source('b3RoZXI=')]]),
    ),
  )

  hook.rerender({ taskId: undefined, listed: [] })
  expect(hook.result.current).toEqual(new Map())
})
