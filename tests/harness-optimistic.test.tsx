import { useProject } from '@/components/project/project-context'
import { ProjectProvider } from '@/components/project/project-provider'
import { useProjects } from '@/hooks/use-projects'
import type { HarnessClient } from '@/services/harness/client'
import {
  activateAPI,
  getView,
  HarnessAPI,
  publish,
} from '@/services/harness/runtime'
import type { Thread } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import type { Project } from '@/types/project'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { testSession } from './harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const thread: Thread = {
  id: 'thread-1',
  title: 'Original',
  titleState: 'manual',
  model: 'test-model',
  projectId: null,
  pinned: false,
  webSearchEnabled: true,
  messageCount: 2,
  activeRun: null,
  createdAt: '2026-09-14T10:00:00Z',
  updatedAt: '2026-09-14T10:00:00Z',
  hasOlder: false,
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: 'Hello',
      createdAt: '2026-09-14T10:00:00Z',
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      timeline: [{ id: 'text', type: 'content', content: 'Hi' }],
      createdAt: '2026-09-14T10:00:00Z',
    },
  ],
}
const project: Project = {
  id: 'project-1',
  name: 'Research',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  syncVersion: 1,
}
function setup() {
  const post = vi.fn().mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: [thread], nextCursor: null }
    if (path === '/v1/threads/get') return thread
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get')
      return {
        ...project,
        documents: [{ id: 'doc-1', projectId: project.id }],
        contextUsage: {},
      }
    throw new Error(`Unexpected request: ${path}`)
  })
  const events = vi.fn()
  const api = new HarnessAPI(
    { post, events } as unknown as HarnessClient,
    'test-user',
  )
  vi.spyOn(api, 'key').mockReturnValue('test-key')
  activateAPI(api)
  publish({ session: testSession, keyReady: true })
  return { api, post, events }
}

it('updates preferences immediately and preserves a newer choice when an earlier save finishes', async () => {
  const { api, post } = setup()
  const first = deferred(),
    second = deferred()
  post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  publish({ profile: { language: 'English', themeMode: 'light' } })
  const one = api.updateProfile({ language: 'French' })
  const two = api.updateProfile({ language: 'German', themeMode: 'dark' })
  expect(getView().profile).toEqual({ language: 'German', themeMode: 'dark' })
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  first.resolve({ language: 'French', themeMode: 'light' })
  await one
  expect(getView().profile).toEqual({ language: 'German', themeMode: 'dark' })
  const failed = expect(two).rejects.toThrow('save failed')
  second.reject(new Error('save failed'))
  await failed
  expect(getView().profile).toEqual({ language: 'French', themeMode: 'light' })
})

it('rebases a functional preference edit after an earlier edit fails', async () => {
  const { api, post } = setup()
  const first = deferred(),
    second = deferred()
  post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  publish({ profile: { presets: [] } })
  const one = api.updateProfile((profile) => ({
    presets: [...profile.presets, 'first'],
  }))
  const two = api.updateProfile((profile) => ({
    presets: [...profile.presets, 'second'],
  }))
  expect(getView().profile.presets).toEqual(['first', 'second'])
  const failed = expect(one).rejects.toThrow('save failed')
  first.reject(new Error('save failed'))
  await failed
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(getView().profile.presets).toEqual(['second'])
  expect(post.mock.calls[1][1].patch).toEqual({ presets: ['second'] })
  second.resolve({ presets: ['second'] })
  await two
})

it('does not let a slow profile refresh erase a confirmed preference edit', async () => {
  const { api, post } = setup()
  const read = deferred(),
    save = deferred()
  publish({ profile: { language: 'English' } })
  post.mockImplementation((path) =>
    path === '/v1/profile/get' ? read.promise : save.promise,
  )
  const refreshing = api.refreshProfile()
  const saving = api.updateProfile({ language: 'French' })
  save.resolve({ language: 'French' })
  await saving
  read.resolve({ language: 'English' })
  await refreshing
  expect(getView().profile.language).toBe('French')
})

it('drops optimistic preferences and late confirmations when the key changes', async () => {
  const { api, post } = setup()
  const save = deferred()
  post.mockReturnValue(save.promise)
  const saving = api.updateProfile({ nickname: 'private' })
  expect(getView().profile.nickname).toBe('private')
  await waitFor(() => expect(post).toHaveBeenCalledOnce())
  api.invalidateKey()
  const aborted = expect(saving).rejects.toMatchObject({ name: 'AbortError' })
  save.resolve({ nickname: 'private' })
  await aborted
  expect(getView().profile).toEqual({})
})

it('pins and renames a chat immediately, rolling back only the failed edit', async () => {
  const { post } = setup()
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.chat.title).toBe('Original'))
  const pin = deferred(),
    rename = deferred()
  post.mockReturnValueOnce(pin.promise).mockReturnValueOnce(rename.promise)
  let one!: Promise<void>, two!: Promise<void>
  act(() => {
    one = result.current.update(thread.id, { pinned: true })
    two = result.current.update(thread.id, { title: 'Renamed' })
  })
  expect(result.current.threads[0].pinned).toBe(true)
  expect(result.current.chat.title).toBe('Renamed')
  const failed = expect(one).rejects.toThrow('pin failed')
  await act(async () => {
    pin.reject(new Error('pin failed'))
    await failed
  })
  expect(result.current.threads[0].pinned).toBe(false)
  expect(result.current.chat.title).toBe('Renamed')
  await act(async () => {
    rename.resolve({ ...thread, title: 'Renamed' })
    await two
  })
  expect(result.current.chat.title).toBe('Renamed')
})

it('keeps a pin visible when an older history response arrives after its confirmation', async () => {
  const { post } = setup()
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.threads).toHaveLength(1))
  const read = deferred(),
    save = deferred()
  post.mockImplementation((path) =>
    path === '/v1/threads/list' ? read.promise : save.promise,
  )
  let refreshing!: Promise<void>, saving!: Promise<void>
  act(() => {
    refreshing = result.current.refresh()
    saving = result.current.update(thread.id, { pinned: true })
  })
  await act(async () => {
    save.resolve({ ...thread, pinned: true })
    await saving
  })
  await act(async () => {
    read.resolve({ threads: [thread], nextCursor: null })
    await refreshing
  })
  expect(result.current.threads[0].pinned).toBe(true)
})

it('removes a chat immediately and restores it on failure without replacing a newly opened chat', async () => {
  const { post } = setup()
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.chat.title).toBe('Original'))
  const deletion = deferred()
  post.mockImplementation(async (path, input) =>
    path === '/v1/threads/delete'
      ? deletion.promise
      : { ...thread, id: input.id, title: 'Another chat' },
  )
  let removing!: Promise<void>
  act(() => {
    removing = result.current.remove(thread.id)
  })
  expect(result.current.threads).toEqual([])
  expect(result.current.chat.id).toBe('')
  await act(() => result.current.open('other-chat'))
  const failed = expect(removing).rejects.toThrow('delete failed')
  await act(async () => {
    deletion.reject(new Error('delete failed'))
    await failed
  })
  expect(result.current.threads[0].id).toBe(thread.id)
  expect(result.current.chat.id).toBe('other-chat')
})

it('shows a submitted message before any server event and replaces the preview with the server message', async () => {
  const { events } = setup()
  const gate = deferred<void>()
  events.mockImplementation(async function* () {
    await gate.promise
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: thread.id, runId: 'run-1' },
    }
    yield {
      id: 1,
      event: {
        type: 'MESSAGES_SNAPSHOT',
        messages: [{ ...thread.messages[0], content: 'New question' }],
      },
    }
    yield {
      id: 2,
      event: { type: 'RUN_FINISHED', runId: 'run-1', threadId: thread.id },
    }
  })
  const { result } = renderHook(() => useThread())
  let sending: ReturnType<typeof result.current.send>
  act(() => {
    sending = result.current.send({ content: 'New question' })
  })
  expect(
    result.current.chat.messages.map((message) => message.content),
  ).toEqual(['New question'])
  expect(result.current.running).toBe(true)
  await act(async () => {
    gate.resolve()
    await sending
  })
  expect(result.current.chat.messages).toHaveLength(1)
  expect(result.current.chat.messages[0].id).toBe('user-1')
  expect(result.current.running).toBe(false)
})

it('restores the previous answer when regeneration fails before a server transcript arrives', async () => {
  const { events } = setup()
  const gate = deferred()
  events.mockImplementation(async function* () {
    await gate.promise
  })
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
  let sending: ReturnType<typeof result.current.send>
  act(() => {
    sending = result.current.send({
      kind: 'regenerate',
      messageId: 'assistant-1',
    })
  })
  expect(result.current.chat.messages).toHaveLength(1)
  expect(result.current.running).toBe(true)
  await act(async () => {
    gate.reject(new TypeError('connection lost'))
    await sending
  })
  expect(result.current.chat.messages).toHaveLength(2)
  expect(result.current.chat.messages[1].content).toBe('Hi')
  expect(result.current.running).toBe(false)
  expect(result.current.error).toBe('connection lost')
})

function Projects({ children }: { children: ReactNode }) {
  return (
    <ProjectProvider initialProjectId={project.id}>{children}</ProjectProvider>
  )
}

it('cancels immediately and restores the running state if cancellation fails', async () => {
  const { post, events } = setup()
  const finish = deferred<void>()
  events.mockImplementation(async function* () {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: thread.id, runId: 'run-1' },
    }
    yield {
      id: 1,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: { ...thread, activeRun: { runId: 'run-1', lastEventId: 1 } },
          queue: [{ queueId: 'queued-1', content: 'Next question' }],
        },
      },
    }
    await finish.promise
    yield {
      id: 2,
      event: { type: 'RUN_FINISHED', threadId: thread.id, runId: 'run-1' },
    }
  })
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
  let sending: ReturnType<typeof result.current.send>
  act(() => {
    sending = result.current.send({ content: 'Next' })
  })
  await waitFor(() =>
    expect(result.current.state.snapshot.queue).toHaveLength(1),
  )

  const cancel = deferred(),
    remove = deferred()
  const original = post.getMockImplementation()!
  post.mockImplementation((path, ...args) =>
    path === '/v1/threads/cancel'
      ? cancel.promise
      : path === '/v1/threads/queue/remove'
        ? remove.promise
        : original(path, ...args),
  )
  let cancelling!: Promise<any>, removing!: Promise<any>
  act(() => {
    cancelling = result.current.cancel()
    removing = result.current.removeQueued('queued-1')
  })
  expect(result.current.running).toBe(false)
  expect(result.current.state.snapshot.queue).toEqual([])
  const failedCancel = expect(cancelling).rejects.toThrow('cancel failed')
  await act(async () => {
    cancel.reject(new Error('cancel failed'))
    await failedCancel
  })
  expect(result.current.running).toBe(true)
  expect(result.current.state.snapshot.queue).toEqual([])
  const failedRemove = expect(removing).rejects.toThrow('remove failed')
  await act(async () => {
    remove.reject(new Error('remove failed'))
    await failedRemove
  })
  expect(result.current.state.snapshot.queue[0].queueId).toBe('queued-1')
  await act(async () => {
    finish.resolve()
    await sending
  })
})
it('updates project names in both the sidebar list and active project before confirmation, then rolls back on failure', async () => {
  const { post } = setup()
  const { result } = renderHook(
    () => ({ ...useProject(), list: useProjects().projects }),
    { wrapper: Projects },
  )
  await waitFor(() =>
    expect(result.current.activeProject?.name).toBe('Research'),
  )
  const saving = deferred()
  post.mockReturnValue(saving.promise)
  let request!: Promise<void>
  act(() => {
    request = result.current.updateProject(project.id, { name: 'Renamed' })
  })
  expect(result.current.activeProject?.name).toBe('Renamed')
  expect(result.current.list[0].name).toBe('Renamed')
  const failed = expect(request).rejects.toThrow('save failed')
  await act(async () => {
    saving.reject(new Error('save failed'))
    await failed
  })
  expect(result.current.activeProject?.name).toBe('Research')
  expect(result.current.list[0].name).toBe('Research')
})

it('restores a failed project deletion in every view', async () => {
  const { post } = setup()
  const { result } = renderHook(
    () => ({ ...useProject(), list: useProjects().projects }),
    { wrapper: Projects },
  )
  await waitFor(() => expect(result.current.activeProject?.id).toBe(project.id))
  const deleting = deferred()
  post.mockReturnValue(deleting.promise)
  let request!: Promise<void>
  act(() => {
    request = result.current.deleteProject(project.id)
  })
  expect(result.current.activeProject).toBeNull()
  expect(result.current.list).toEqual([])
  const failed = expect(request).rejects.toThrow('delete failed')
  await act(async () => {
    deleting.reject(new Error('delete failed'))
    await failed
  })
  expect(result.current.activeProject?.id).toBe(project.id)
  expect(result.current.list).toHaveLength(1)
})

it('removes a document immediately and restores it if deletion fails', async () => {
  const { post } = setup()
  const { result } = renderHook(() => useProject(), { wrapper: Projects })
  await waitFor(() => expect(result.current.projectDocuments).toHaveLength(1))
  const deleting = deferred()
  post.mockReturnValue(deleting.promise)
  let request!: Promise<void>
  act(() => {
    request = result.current.removeDocument('doc-1')
  })
  expect(result.current.projectDocuments).toEqual([])
  const failed = expect(request).rejects.toThrow('delete failed')
  await act(async () => {
    deleting.reject(new Error('delete failed'))
    await failed
  })
  expect(result.current.projectDocuments[0].id).toBe('doc-1')
})

it('does not duplicate a newly created project when a concurrent list request includes it', async () => {
  const { post } = setup()
  const { result } = renderHook(
    () => ({ context: useProject(), list: useProjects() }),
    { wrapper: Projects },
  )
  await waitFor(() => expect(result.current.list.projects).toHaveLength(1))
  const read = deferred(),
    create = deferred()
  const created = { ...project, id: 'project-2', name: 'New project' }
  post.mockImplementation((path) =>
    path === '/v1/projects/list' ? read.promise : create.promise,
  )
  let reading!: Promise<void>, creating!: Promise<Project>
  act(() => {
    reading = result.current.list.refresh()
    creating = result.current.context.createProject({ name: created.name })
  })
  expect(result.current.context.loadingProject?.name).toBe(created.name)
  await act(async () => {
    create.resolve(created)
    await creating
  })
  await act(async () => {
    read.resolve({ projects: [created, project], nextCursor: null })
    await reading
  })
  expect(result.current.list.projects.map((item) => item.id)).toEqual([
    created.id,
    project.id,
  ])
})

it('keeps a saved project edit when an older document refresh arrives', async () => {
  const { post } = setup()
  const { result } = renderHook(() => useProject(), { wrapper: Projects })
  await waitFor(() =>
    expect(result.current.activeProject?.name).toBe('Research'),
  )
  const read = deferred(),
    save = deferred()
  post.mockImplementation((path) =>
    path === '/v1/projects/get' ? read.promise : save.promise,
  )
  let reading!: Promise<void>, saving!: Promise<void>
  act(() => {
    reading = result.current.refreshDocuments()
    saving = result.current.updateProject(project.id, { name: 'Renamed' })
  })
  await act(async () => {
    save.resolve({ ...project, name: 'Renamed' })
    await saving
  })
  await act(async () => {
    read.resolve({ ...project, documents: [], contextUsage: {} })
    await reading
  })
  expect(result.current.activeProject?.name).toBe('Renamed')
})
