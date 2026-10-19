import { PROJECTS_CHANGED, useProjects } from '@/hooks/use-projects'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const project = (id: string) => ({
  id,
  name: id,
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  syncVersion: 1,
})
const ALPHA = project('alpha')
const BETA = project('beta')

let post: ReturnType<typeof vi.fn>

beforeEach(() => {
  post = vi.fn()
  const api = new HarnessAPI({ post } as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue('Y29udGVudC1rZXk=')
  activateAPI(api)
  publish({ keyReady: true, profileReady: true })
})

it('keeps the list read after a change when an earlier read finishes last', async () => {
  let finishStale!: (page: unknown) => void
  post
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishStale = resolve
      }),
    )
    .mockResolvedValueOnce({ projects: [ALPHA, BETA], nextCursor: null })
  const { result } = renderHook(() => useProjects())
  await waitFor(() => expect(post).toHaveBeenCalledOnce())

  act(() => {
    window.dispatchEvent(new Event(PROJECTS_CHANGED))
  })
  await waitFor(() => expect(result.current.projects).toEqual([ALPHA, BETA]))
  await act(async () => finishStale({ projects: [ALPHA], nextCursor: null }))

  expect(result.current.projects).toEqual([ALPHA, BETA])
  expect(result.current.loading).toBe(false)
  expect(post.mock.calls.map(([path]) => path)).toEqual([
    '/v1/projects/list',
    '/v1/projects/list',
  ])
})

it('lists the projects once for the hooks that load them together', async () => {
  post.mockResolvedValue({ projects: [ALPHA], nextCursor: null })
  // The chat page and its sidebar both load the list when they mount.
  const { result } = renderHook(() => [useProjects(), useProjects()])

  await waitFor(() =>
    expect(result.current.map((hook) => hook.projects)).toEqual([
      [ALPHA],
      [ALPHA],
    ]),
  )
  expect(post).toHaveBeenCalledExactlyOnceWith(
    '/v1/projects/list',
    { key: 'Y29udGVudC1rZXk=', cursor: null },
    expect.any(AbortSignal),
  )
})

it('shows a refresh from one hook wherever the projects are listed', async () => {
  post
    .mockResolvedValueOnce({ projects: [ALPHA], nextCursor: null })
    .mockResolvedValueOnce({ projects: [ALPHA, BETA], nextCursor: null })
  // The sidebar lists the projects; settings refreshes them after an import.
  const { result } = renderHook(() => ({
    sidebar: useProjects(),
    settings: useProjects({ autoLoad: false }),
  }))
  await waitFor(() => expect(result.current.sidebar.projects).toEqual([ALPHA]))

  await act(() => result.current.settings.refresh())

  expect(result.current.sidebar.projects).toEqual([ALPHA, BETA])
  expect(post).toHaveBeenCalledTimes(2)
})

it('resolves a failed refresh and keeps its error', async () => {
  post.mockRejectedValue(
    new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'Projects are unavailable' },
      503,
    ),
  )
  const { result } = renderHook(() => useProjects({ autoLoad: false }))

  await act(() => result.current.refresh())

  expect(result.current.error).toBe('Projects are unavailable')
  expect(result.current.loading).toBe(false)
  expect(result.current.projects).toEqual([])
})
