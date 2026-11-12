import { initialChat } from '@tinfoil/chat-client/reducer'
import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import { TaskStore } from '../src/storage'

const stores: TaskStore[] = []
const open = (name = crypto.randomUUID()) => {
  const store = new TaskStore(name)
  stores.push(store)
  return store
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

test('a replay returns the journaled result without repeating the action', async () => {
  const store = open()
  let clicks = 0
  const click = async () => ({ text: `Saved ${++clicks}` })
  expect(
    await store.executeOnce('alice', 'task', 'run', 'click', click),
  ).toEqual({ text: 'Saved 1' })
  expect(
    await store.executeOnce('alice', 'task', 'run', 'click', click),
  ).toEqual({ text: 'Saved 1' })
  expect(clicks).toBe(1)
  expect(await store.executeOnce('bob', 'task', 'run', 'click', click)).toEqual(
    { text: 'Saved 2' },
  )
})

test('an interrupted mutation stays uncertain after the database is reopened', async () => {
  const name = crypto.randomUUID()
  const store = open(name)
  let submitted = 0
  await expect(
    store.executeOnce('alice', 'task', 'run', 'submit', async () => {
      submitted++
      throw new Error('Worker stopped before the result was written')
    }),
  ).rejects.toThrow('Worker stopped')
  await store.close()
  const reopened = open(name)
  await expect(
    reopened.executeOnce('alice', 'task', 'run', 'submit', async () => {
      submitted++
      return { text: 'Submitted again' }
    }),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  expect(submitted).toBe(1)
})

test('concurrent deliveries cannot both execute a mutation', async () => {
  const store = open()
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  let writes = 0
  const first = store.executeOnce('alice', 'task', 'run', 'save', async () => {
    writes++
    started()
    await wait
    return { text: 'Saved' }
  })
  await firstStarted
  await expect(
    store.executeOnce('alice', 'task', 'run', 'save', async () => {
      writes++
      return { text: 'Saved twice' }
    }),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  finish()
  expect(await first).toEqual({ text: 'Saved' })
  expect(writes).toBe(1)
})

test('deleting local history removes its journal while preserving another account', async () => {
  const store = open()
  const task = {
    id: 'task',
    title: 'Private task',
    updatedAt: 1,
    state: initialChat(),
    phase: 'completed' as const,
    lastPrompt: 'Save this',
    model: 'gpt-oss-120b',
    effort: 'low' as const,
    tabs: [],
    confirmActions: true,
  }
  for (const owner of ['alice', 'bob']) {
    await store.put({ ...task, owner })
    await store.executeOnce(owner, task.id, 'run', 'save', async () => ({
      text: owner,
    }))
  }
  await store.delete('alice', task.id)
  expect(await store.list('alice')).toEqual([])
  expect(await store.action('alice', 'run', 'save')).toBeUndefined()
  expect(await store.list('bob')).toEqual([{ ...task, owner: 'bob' }])
  expect((await store.action('bob', 'run', 'save'))?.result).toEqual({
    text: 'bob',
  })
})
