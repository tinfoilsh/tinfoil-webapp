import { usePromptLibrary } from '@/components/chat/hooks/use-prompt-library'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import { localThreadStore } from '@/services/harness/local-threads'
import {
  activateAPI,
  getView,
  HarnessAPI,
  MIGRATED_CUSTOM_PROMPT_PRESET_ID,
  publish,
} from '@/services/harness/runtime'
import type { Frame, Session, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { testSession } from '../../harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const KEY = 'Y29udGVudC1rZXk='
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
      name: 'Deep model',
      multimodal: false,
      reasoning: null,
    },
  ],
}

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

function signIn({
  cloud,
  profile = {},
}: {
  cloud: boolean
  profile?: Record<string, unknown>
}) {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  localStorage.setItem(
    'tinfoil-settings-cloud-sync-enabled',
    cloud ? 'true' : 'false',
  )
  client = {
    events: vi.fn(),
    post: vi.fn(async (path: string, input: Record<string, unknown>) =>
      path === '/v1/threads/list'
        ? { threads: [], nextCursor: null }
        : path === '/v1/profile/update'
          ? { ...getView().profile, ...(input.patch as object) }
          : {},
    ),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session,
    profile: {
      customPromptPresets: [RESEARCH, QUIET],
      ...profile,
    },
    keyReady: true,
    profileReady: true,
  })
  return api
}

function finished(threadId: string) {
  return async function* (): AsyncGenerator<Frame> {
    yield { id: 0, event: { type: 'RUN_STARTED', threadId, runId: 'run-1' } }
    yield { id: 1, event: { type: 'RUN_FINISHED', threadId, runId: 'run-1' } }
  }
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn
// What the attested client sends: the turn as JSON, without undefined fields.
const sent = (call = 0) => JSON.parse(JSON.stringify(turn(call)))

beforeAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: FakeIDBKeyRange,
  })
})

beforeEach(async () => {
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  vi.restoreAllMocks()
})

describe('the default prompt of a new stored chat', () => {
  it('shows the default and leaves it to the harness to stamp', async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: QUIET.id } })
    client.events.mockImplementation(finished('thread-1'))
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    expect(result.current.presetId).toBe(QUIET.id)
    expect(result.current.chat.webSearchEnabled).toBe(false)

    await act(() => result.current.send({ content: 'Hi' }))

    expect(sent()).not.toHaveProperty('presetId')
    expect(sent().key).toBe(KEY)
    // The chat keeps showing the prompt it started with.
    expect(result.current.chat.id).toBe('thread-1')
    expect(result.current.presetId).toBe(QUIET.id)
  })

  it('names a prompt chosen instead, or none', async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: QUIET.id } })
    client.events.mockImplementation(finished('thread-1'))
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

  it('names the default itself in a temporary chat, which is not stamped', async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: QUIET.id } })
    client.events.mockImplementation(finished('thread-1'))
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    act(() => result.current.setTemporary(true))

    await act(() => result.current.send({ content: 'Hi' }))

    expect(turn()).toMatchObject({ ephemeral: true, presetId: QUIET.id })
  })

  it("applies the default prompt's model to a new chat", async () => {
    signIn({ cloud: true, profile: { defaultPromptPresetId: RESEARCH.id } })
    client.events.mockImplementation(finished('thread-1'))
    const { result } = renderHook(() => useThread())

    await waitFor(() => expect(result.current.model).toBe('deep-model'))
    expect(result.current.chat.webSearchEnabled).toBe(true)
    await act(() => result.current.send({ content: 'Hi' }))
    expect(turn().options?.model).toBe('deep-model')
  })
})

describe('the default prompt of a new local chat', () => {
  it('is stamped on the local copy the turn carries', async () => {
    signIn({ cloud: false, profile: { defaultPromptPresetId: QUIET.id } })
    client.events.mockImplementation((_path: string, input: Turn) =>
      finished(input.threadId!)(),
    )
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'Hi' }))

    expect(turn()).toMatchObject({
      local: true,
      thread: { presetId: QUIET.id, webSearchEnabled: false },
    })
    expect(result.current.chat.id).toBe(turn().threadId)
    expect(result.current.presetId).toBe(QUIET.id)
  })
})

describe('choosing a saved prompt', () => {
  it('applies its model and web search to a stored chat and stores them', async () => {
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
          ...(input as object),
        }
      return { threads: [], nextCursor: null }
    })
    const { result } = renderHook(() => useThread('thread-1', null))
    await waitFor(() => expect(result.current.chat.id).toBe('thread-1'))

    await act(() => result.current.selectPreset(RESEARCH.id))

    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/update',
      {
        key: KEY,
        id: 'thread-1',
        presetId: RESEARCH.id,
        model: 'deep-model',
        webSearchEnabled: true,
      },
      expect.any(AbortSignal),
    )
    expect(result.current.model).toBe('deep-model')
    expect(result.current.chat.webSearchEnabled).toBe(true)
    expect(result.current.presetId).toBe(RESEARCH.id)
  })

  it('skips a model the catalog no longer offers', async () => {
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
    expect(
      client.post.mock.calls
        .filter(([path]) => path === '/v1/profile/update')
        .map(([, input]) => input.patch),
    ).toEqual([
      { favoritePromptPresetIds: [RESEARCH.id] },
      { favoritePromptPresetIds: [RESEARCH.id, QUIET.id] },
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
  })

  it('clears a retired model from saved prompts', async () => {
    signIn({ cloud: true })
    const { result } = renderHook(() => usePromptLibrary())

    let pruned: string[] = []
    act(() => {
      pruned = result.current.pruneUnavailableModels([
        {
          modelName: 'test-model',
          name: 'Test model',
          nameShort: 'Test',
          image: '',
          description: '',
          type: 'chat',
          chat: true,
        },
      ])
    })

    expect(pruned).toEqual([RESEARCH.id])
    await waitFor(() =>
      expect(
        (getView().profile.customPromptPresets as object[])[0],
      ).not.toHaveProperty('model'),
    )
  })
})

describe('the custom default prompt', () => {
  it('moves to a saved prompt that new chats start with', async () => {
    const api = signIn({ cloud: false })
    localStorage.setItem(
      'tinfoil-user-prefs-local-profile',
      JSON.stringify({
        isUsingCustomPrompt: true,
        customSystemPrompt: '<system>Answer in French.</system>',
      }),
    )

    await act(() => api.refreshProfile())

    await waitFor(() =>
      expect(getView().profile).toEqual({
        isUsingCustomPrompt: false,
        customSystemPrompt: '',
        defaultPromptPresetId: MIGRATED_CUSTOM_PROMPT_PRESET_ID,
        customPromptPresets: [
          {
            id: MIGRATED_CUSTOM_PROMPT_PRESET_ID,
            name: 'My default prompt',
            description: 'Migrated from the custom default prompt setting',
            systemPrompt: '<system>Answer in French.</system>',
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number),
          },
        ],
      }),
    )
  })

  it('is turned off without replacing a default already chosen', async () => {
    const api = signIn({ cloud: false })
    localStorage.setItem(
      'tinfoil-user-prefs-local-profile',
      JSON.stringify({
        isUsingCustomPrompt: true,
        customSystemPrompt: 'Answer in French.',
        defaultPromptPresetId: 'builtin:tutor',
      }),
    )

    await act(() => api.refreshProfile())

    await waitFor(() =>
      expect(getView().profile).toEqual({
        isUsingCustomPrompt: false,
        customSystemPrompt: '',
        defaultPromptPresetId: 'builtin:tutor',
      }),
    )
  })
})

describe('local settings', () => {
  it("import the previous client's default prompt once", async () => {
    signIn({ cloud: false })
    localStorage.setItem(
      'tinfoil-user-prefs-default-prompt-preset-id',
      QUIET.id,
    )
    localStorage.setItem(
      'tinfoil-user-prefs-custom-prompt-presets',
      JSON.stringify([QUIET, { ...RESEARCH, webSearchEnabled: 'yes' }]),
    )
    const { loadLocalProfile } =
      await import('@/services/harness/local-profile')

    expect(loadLocalProfile()).toEqual({ defaultPromptPresetId: QUIET.id })
    localStorage.setItem(
      'tinfoil-user-prefs-default-prompt-preset-id',
      RESEARCH.id,
    )
    expect(loadLocalProfile()).toEqual({ defaultPromptPresetId: QUIET.id })
  })

  it('keep valid saved prompt settings', async () => {
    signIn({ cloud: false })
    localStorage.setItem(
      'tinfoil-user-prefs-custom-prompt-presets',
      JSON.stringify([QUIET, RESEARCH]),
    )
    const { loadLocalProfile } =
      await import('@/services/harness/local-profile')

    expect(loadLocalProfile()).toEqual({
      customPromptPresets: [QUIET, RESEARCH],
    })
    expect(await localThreadStore('device').list()).toEqual([])
  })
})
