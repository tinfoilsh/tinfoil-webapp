import { usePromptLibrary } from '@/components/chat/hooks/use-prompt-library'
import { localThreadStore } from '@/services/harness/local-threads'
import { getView, publish } from '@/services/harness/runtime'
import type { Frame, Session, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_SECRET,
  client,
  KEY,
  signIn as signInTo,
  testSession,
} from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const RESEARCH = {
  id: 'user:research',
  name: 'Research',
  description: 'Cites sources',
  systemPrompt: '<system>Cite sources.</system>',
  createdAt: 1,
  updatedAt: 1,
  model: 'deep-model',
  webSearchEnabled: true,
}
const QUIET = {
  id: 'user:quiet',
  name: 'Quiet',
  description: '',
  systemPrompt: '<system>Be brief.</system>',
  createdAt: 1,
  updatedAt: 1,
  webSearchEnabled: false,
}
const session: Session = {
  ...testSession,
  models: [
    ...testSession.models,
    {
      id: 'deep-model',
      label: 'Deep model',
      shortLabel: 'Deep',
      icon: '',
      description: '',
      badges: [],
      reasoning: null,
      deprecated: false,
    },
  ],
}

function signIn({
  cloud,
  profile = {},
  profileDefaults = {},
  edits = true,
}: {
  cloud: boolean
  profile?: Record<string, unknown>
  profileDefaults?: Session['profileDefaults']
  // The harness takes edits to saved prompts and favorites by id.
  edits?: boolean
}) {
  const api = signInTo({
    cloud,
    session: {
      ...session,
      profileDefaults,
      features: { ...session.features, promptPresetEdits: edits },
    },
    profile: { customPromptPresets: [RESEARCH, QUIET], ...profile },
  })
  client.post.mockImplementation(
    async (path: string, input: Record<string, unknown>) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/profile/update')
        return { ...getView().profile, ...(input.patch as object) }
      throw new Error(`Unexpected harness request: ${path}`)
    },
  )
  return api
}

// Each turn's run starts and finishes in the chat the turn names.
function finishEachTurn() {
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    const threadId = input.threadId!
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId,
        runId: 'run-1',
        instance: 'instance-1',
      },
    }
    yield {
      id: 1,
      event: { type: 'RUN_FINISHED', threadId, runId: 'run-1', metadata: {} },
    }
  })
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn
const profileUpdates = () =>
  client.post.mock.calls
    .filter(([path]) => path === '/v1/profile/update')
    .map(([, input]) => input)
// What the attested client sends: the turn as JSON, without undefined fields.
const sent = (call = 0) => JSON.parse(JSON.stringify(turn(call)))

resetChatStoresAroundEachTest()

describe('the default prompt of a new stored chat', () => {
  it('shows the default and leaves it to the harness to stamp', async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: QUIET.id } })
    finishEachTurn()
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    expect(result.current.presetId).toBe(QUIET.id)
    expect(result.current.chat.webSearchEnabled).toBe(false)

    await act(() => result.current.send({ content: 'Hi' }))

    expect(sent()).not.toHaveProperty('presetId')
    expect(sent().key).toBe(KEY)
    // The chat keeps showing the prompt it started with.
    expect(result.current.chat.id).toBe(sent().threadId)
    expect(result.current.presetId).toBe(QUIET.id)
  })

  it('names a prompt chosen instead, or none', async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: QUIET.id } })
    finishEachTurn()
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.selectPreset(null))
    expect(result.current.presetId).toBeNull()
    await act(() => result.current.send({ content: 'Hi' }))
    expect(turn()).toMatchObject({ presetId: null })

    act(() => result.current.newChat())
    expect(result.current.presetId).toBe(QUIET.id)
    await act(() => result.current.selectPreset('builtin:tutor'))
    await act(() => result.current.send({ content: 'Teach me' }))
    expect(turn(1)).toMatchObject({ presetId: 'builtin:tutor' })
  })

  it("shows the default prompt's model and web search, and leaves them to the harness", async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: RESEARCH.id } })
    finishEachTurn()
    const { result } = renderHook(() => useThread())

    await waitFor(() => expect(result.current.model).toBe('deep-model'))
    expect(result.current.chat.webSearchEnabled).toBe(true)
    await act(() =>
      result.current.send({
        content: 'Hi',
        options: { model: 'deep-model', webSearch: true, thinking: true },
      }),
    )

    expect(turn().options).toEqual({
      thinking: true,
      cacheSecret: CACHE_SECRET,
    })
    expect(result.current.model).toBe('deep-model')
    expect(result.current.chat.webSearchEnabled).toBe(true)
  })

  it("shows the settings of the session's default prompt when the profile names none", async () => {
    signIn({
      cloud: true,
      profileDefaults: { defaultPromptPresetId: RESEARCH.id },
    })
    const { result } = renderHook(() => useThread())

    await waitFor(() => expect(result.current.model).toBe('deep-model'))
    expect(result.current.presetId).toBe(RESEARCH.id)
    expect(result.current.chat.webSearchEnabled).toBe(true)
  })

  it("keeps showing the session's default prompt after the first turn", async () => {
    signIn({
      cloud: true,
      profileDefaults: { defaultPromptPresetId: RESEARCH.id },
    })
    finishEachTurn()
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('deep-model'))

    await act(() => result.current.send({ content: 'Hi' }))

    expect(result.current.presetId).toBe(RESEARCH.id)
  })

  it("sends a model chosen over the prompt's", async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: RESEARCH.id } })
    finishEachTurn()
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('deep-model'))

    act(() => result.current.setModel('test-model'))
    expect(result.current.model).toBe('test-model')
    await act(() =>
      result.current.send({
        content: 'Hi',
        options: { model: 'test-model', webSearch: true },
      }),
    )

    expect(turn().options).toEqual({
      model: 'test-model',
      cacheSecret: CACHE_SECRET,
    })
  })

  it('does not show a model the catalog no longer offers', async () => {
    signIn({
      cloud: true,
      profile: {
        customPromptPresets: [{ ...RESEARCH, model: 'retired-model' }],
      },
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.selectPreset(RESEARCH.id))

    expect(result.current.model).toBe('test-model')
    expect(result.current.chat.webSearchEnabled).toBe(true)
  })
})

describe('the default prompt of a new device chat', () => {
  it('is left to the harness, which makes the chat from its first turn', async () => {
    signIn({ cloud: false, profile: { defaultPromptPresetId: QUIET.id } })
    finishEachTurn()
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'Hi' }))

    expect(sent()).toEqual({
      clientRequestId: expect.any(String),
      threadId: expect.any(String),
      kind: 'send',
      widgets: [],
      options: {
        model: 'test-model',
        timezone: expect.any(String),
        cacheSecret: CACHE_SECRET,
      },
      content: 'Hi',
      local: true,
      profile: {
        customPromptPresets: [RESEARCH, QUIET],
        defaultPromptPresetId: QUIET.id,
      },
    })
    expect(result.current.chat.id).toBe(turn().threadId)
    expect(result.current.presetId).toBe(QUIET.id)
  })
})

describe('choosing a saved prompt', () => {
  it('names it to the harness for a stored chat, and shows the settings it applied', async () => {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path: string, input) => {
      if (path === '/v1/threads/get')
        return {
          id: 'thread-1',
          title: 'A chat',
          titleState: 'generated',
          createdAt: '2026-04-01T09:00:00Z',
          updatedAt: '2026-04-01T09:00:00Z',
          model: 'test-model',
          projectId: null,
          pinned: false,
          webSearchEnabled: false,
          messageCount: 0,
          activeRun: null,
          hasOlder: false,
          messages: [],
        }
      if (path === '/v1/threads/update')
        return {
          id: 'thread-1',
          title: 'A chat',
          titleState: 'generated',
          createdAt: '2026-04-01T09:00:00Z',
          updatedAt: '2026-04-01T09:00:00Z',
          projectId: null,
          pinned: false,
          messageCount: 0,
          activeRun: null,
          model: 'deep-model',
          webSearchEnabled: true,
          presetId: (input as { presetId: string }).presetId,
        }
      return { threads: [], nextCursor: null }
    })
    const { result } = renderHook(() => useThread('thread-1', null))
    await waitFor(() =>
      expect(result.current).toMatchObject({
        chat: { id: 'thread-1' },
        loading: false,
      }),
    )

    await act(() => result.current.selectPreset(RESEARCH.id))

    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/update',
      { key: KEY, id: 'thread-1', presetId: RESEARCH.id },
      expect.any(AbortSignal),
    )
    expect(result.current.model).toBe('deep-model')
    expect(result.current.chat.webSearchEnabled).toBe(true)
    expect(result.current.presetId).toBe(RESEARCH.id)
  })

  it('stores the chat the harness returns for a device chat', async () => {
    signIn({ cloud: false })
    const id = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
    const before = storedThread(id, {
      messages: [{ id: 'u1', role: 'user', createdAt: 't1', content: 'Hi' }],
    })
    const applied = {
      ...before,
      presetId: RESEARCH.id,
      model: 'deep-model',
      webSearchEnabled: true,
    }
    await localThreadStore('device').update(id, () => before)
    const { result } = renderHook(() => useThread(id, null, { local: true }))
    await waitFor(() =>
      expect(result.current).toMatchObject({ chat: { id }, loading: false }),
    )
    client.post.mockResolvedValueOnce({ thread: applied })

    await act(() => result.current.selectPreset(RESEARCH.id))

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/update',
      {
        id,
        presetId: RESEARCH.id,
        // The saved prompt the harness applies is in the profile.
        profile: { customPromptPresets: [RESEARCH, QUIET] },
        local: true,
        thread: before,
      },
      expect.any(AbortSignal),
    )
    expect(await localThreadStore('device').get(id)).toEqual(applied)
    expect(result.current.model).toBe('deep-model')
    expect(result.current.chat.webSearchEnabled).toBe(true)
  })
})

describe('the prompt library', () => {
  it('sets and clears the default prompt in the profile', async () => {
    signIn({ cloud: true })
    const { result } = renderHook(() => usePromptLibrary())

    act(() => result.current.setDefaultPreset(RESEARCH.id))
    await waitFor(() =>
      expect(result.current.defaultPreset?.id).toBe(RESEARCH.id),
    )
    act(() => result.current.setDefaultPreset(null))
    await waitFor(() => expect(result.current.defaultPresetId).toBeNull())

    expect(
      client.post.mock.calls
        .filter(([path]) => path === '/v1/profile/update')
        .map(([, input]) => input.patch),
    ).toEqual([
      { defaultPromptPresetId: RESEARCH.id },
      { defaultPromptPresetId: '' },
    ])
  })

  it('stops a deleted prompt being a favorite or the default', async () => {
    signIn({
      cloud: true,
      profile: {
        defaultPromptPresetId: QUIET.id,
        favoritePromptPresetIds: [QUIET.id, RESEARCH.id],
      },
    })
    const { result } = renderHook(() => usePromptLibrary())

    act(() => result.current.deleteUserPreset(QUIET.id))

    await waitFor(() =>
      expect(getView().profile).toMatchObject({
        customPromptPresets: [RESEARCH],
        favoritePromptPresetIds: [RESEARCH.id],
        defaultPromptPresetId: '',
      }),
    )
    expect(profileUpdates()).toEqual([
      { key: KEY, deletePromptPresetIds: [QUIET.id] },
    ])
  })

  it('adds a prompt by id, so prompts this device has not loaded stay', async () => {
    signIn({ cloud: true, profile: { customPromptPresets: [] } })
    publish({ profileReady: false })
    client.post.mockImplementation(
      async (path: string, input: Record<string, unknown>) => {
        if (path !== '/v1/profile/update')
          throw new Error(`Unexpected harness request: ${path}`)
        return {
          customPromptPresets: [
            RESEARCH,
            QUIET,
            ...(input.savePromptPresets as object[]),
          ],
        }
      },
    )
    const { result } = renderHook(() => usePromptLibrary())

    let created = { id: '' }
    act(() => {
      created = result.current.createUserPreset({
        name: 'Notes',
        description: '',
        systemPrompt: 'Take notes.',
      })
    })

    await waitFor(() =>
      expect(result.current.userPresets.map((p) => p.id)).toEqual([
        RESEARCH.id,
        QUIET.id,
        created.id,
      ]),
    )
    expect(profileUpdates()).toEqual([
      {
        key: KEY,
        savePromptPresets: [
          {
            id: created.id,
            name: 'Notes',
            description: '',
            systemPrompt: 'Take notes.',
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number),
          },
        ],
      },
    ])
  })

  it('sends a harness that takes only whole lists the loaded list', async () => {
    signIn({ cloud: true, edits: false })
    const { result } = renderHook(() => usePromptLibrary())

    act(() => result.current.deleteUserPreset(QUIET.id))

    await waitFor(() => expect(profileUpdates()).toHaveLength(1))
    expect(profileUpdates()[0].patch).toEqual({
      customPromptPresets: [RESEARCH],
      favoritePromptPresetIds: [],
    })
  })

  it('changes no prompt before the profile loads on a harness that takes only whole lists', async () => {
    signIn({ cloud: true, profile: { customPromptPresets: [] }, edits: false })
    publish({ profileReady: false })
    const { result } = renderHook(() => usePromptLibrary())

    await act(async () => {
      result.current.createUserPreset({
        name: 'Notes',
        description: '',
        systemPrompt: 'Take notes.',
      })
    })

    expect(profileUpdates()).toEqual([])
    expect(result.current.userPresets).toEqual([])
  })

  it('keeps both prompts favorited in quick succession', async () => {
    signIn({ cloud: true })
    const { result } = renderHook(() => usePromptLibrary())

    act(() => {
      result.current.toggleFavorite(RESEARCH.id)
      result.current.toggleFavorite(QUIET.id)
    })

    await waitFor(() =>
      expect(result.current.favoritePresets.map((p) => p.id)).toEqual([
        RESEARCH.id,
        QUIET.id,
      ]),
    )
    expect(profileUpdates()).toEqual([
      { key: KEY, addFavoritePromptPresetIds: [RESEARCH.id] },
      { key: KEY, addFavoritePromptPresetIds: [QUIET.id] },
    ])
  })

  it('frees the slot of a favorite that is no longer a prompt', async () => {
    signIn({
      cloud: true,
      profile: {
        favoritePromptPresetIds: ['user:gone', 'builtin:gone', RESEARCH.id],
      },
    })
    const { result } = renderHook(() => usePromptLibrary())
    expect(result.current.canAddFavorite).toBe(true)

    act(() => result.current.toggleFavorite(QUIET.id))

    await waitFor(() => expect(result.current.isFavorite(QUIET.id)).toBe(true))
    expect(result.current.favoritePresets.map((p) => p.id)).toEqual([
      RESEARCH.id,
      QUIET.id,
    ])
  })

  it('stores the settings a saved prompt chooses, and removes unset ones', async () => {
    signIn({ cloud: true })
    const { result } = renderHook(() => usePromptLibrary())

    act(() =>
      result.current.updateUserPreset(RESEARCH.id, {
        name: 'Research',
        description: 'Cites sources',
        systemPrompt: RESEARCH.systemPrompt,
        model: undefined,
        webSearchEnabled: false,
      }),
    )

    await waitFor(() =>
      expect((getView().profile.customPromptPresets as object[])[0]).toEqual({
        ...RESEARCH,
        model: undefined,
        webSearchEnabled: false,
        updatedAt: expect.any(Number),
      }),
    )
    expect(
      (getView().profile.customPromptPresets as object[])[0],
    ).not.toHaveProperty('model')
    const [update] = profileUpdates()
    expect(update).not.toHaveProperty('patch')
    expect(update.savePromptPresets).toEqual([
      {
        ...RESEARCH,
        model: undefined,
        webSearchEnabled: false,
        updatedAt: expect.any(Number),
      },
    ])
    expect(update.savePromptPresets[0]).not.toHaveProperty('model')
  })
})
