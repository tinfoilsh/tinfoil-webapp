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
