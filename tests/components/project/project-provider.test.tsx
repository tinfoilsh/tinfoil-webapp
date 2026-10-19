import {
  useProject,
  type ProjectContextValue,
} from '@/components/project/project-context'
import { ProjectProvider } from '@/components/project/project-provider'
import { harnessAPI } from '@/services/harness/runtime'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-subscription-status', () => ({
  useSubscriptionStatus: () => ({
    isLoading: false,
    chat_subscription_active: true,
  }),
}))

const NAMES: Record<string, string> = { alpha: 'Alpha', beta: 'Beta' }

function stored(id: string) {
  return {
    id,
    name: NAMES[id],
    description: '',
    systemInstructions: '',
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-01T12:00:00Z',
    documents: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let held: Partial<Record<string, Promise<unknown>>>
const client = () => harnessAPI().client
const loads = () =>
  vi
    .mocked(client().post)
    .mock.calls.filter(([path]) => path === '/v1/projects/get')
    .map(([, input]) => (input as { id: string }).id)

let context!: ProjectContextValue
function Projects() {
  context = useProject()
  return (
    <output aria-label="Open project">
      {context.activeProject?.name ?? 'none'}
    </output>
  )
}

beforeEach(() => {
  held = {}
  vi.mocked(client().post).mockImplementation(
    async (path: string, input: unknown) => {
      if (held[path]) return held[path]
      const body = input as { id?: string }
      if (path === '/v1/projects/get') return stored(body.id!)
      throw new Error(`Unexpected request: ${path}`)
    },
  )
  vi.mocked(client().upload).mockResolvedValue({ id: 'doc-1' })
})

describe('ProjectProvider', () => {
  it.each([
    {
      change: 'an upload',
      hold: () => {
        const request = deferred<unknown>()
        vi.mocked(client().upload).mockReturnValueOnce(request.promise)
        return request
      },
      start: (projects: ProjectContextValue) =>
        projects.uploadDocument(new File(['notes'], 'notes.txt'), ''),
      response: { id: 'doc-1' },
    },
    {
      change: 'a settings change',
      hold: () => {
        const request = deferred<unknown>()
        held['/v1/projects/update'] = request.promise
        return request
      },
      start: (projects: ProjectContextValue) =>
        projects.updateProject('alpha', { name: 'Renamed' }),
      response: {},
    },
  ])(
    'keeps the project opened since when $change to the previous one finishes',
    async ({ hold, start, response }) => {
      render(
        <ProjectProvider>
          <Projects />
        </ProjectProvider>,
      )
      await act(() => context.enterProjectMode('alpha'))
      const request = hold()
      let changing!: Promise<unknown>
      act(() => {
        changing = start(context)
      })
      await waitFor(() =>
        expect(
          vi.mocked(client().upload).mock.calls.length +
            vi
              .mocked(client().post)
              .mock.calls.filter(([path]) => path !== '/v1/projects/get')
              .length,
        ).toBe(1),
      )

      await act(() => context.enterProjectMode('beta'))
      await act(async () => {
        request.resolve(response)
        await changing
      })

      expect(screen.getByLabelText('Open project')).toHaveTextContent('Beta')
      expect(context.activeProject).toMatchObject({ id: 'beta' })
      expect(loads()).toEqual(['alpha', 'beta'])
    },
  )

  it('reloads the open project after its own change', async () => {
    render(
      <ProjectProvider>
        <Projects />
      </ProjectProvider>,
    )
    await act(() => context.enterProjectMode('alpha'))

    await act(() => context.uploadDocument(new File(['x'], 'x.txt'), ''))

    expect(loads()).toEqual(['alpha', 'alpha'])
  })
})
