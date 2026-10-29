import ChatCatchAllPage from '@/pages/chat/[[...slug]]'
import ProjectCatchAllPage from '@/pages/project/[[...slug]]'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  router: { isReady: true, query: {} as { slug?: string | string[] } },
  chat: vi.fn(),
  project: vi.fn(),
}))

vi.mock('next/router', () => ({ useRouter: () => mocks.router }))
vi.mock('@/components/ui/logo-loading', () => ({
  LogoLoading: () => <div role="status" aria-label="Loading route" />,
}))
vi.mock('@/components/chat', () => ({
  ChatInterface: (props: unknown) => {
    mocks.chat(props)
    return null
  },
}))
vi.mock('@/components/project', () => ({
  ProjectProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/project/premium-project-route', () => ({
  PremiumProjectRoute: (props: unknown) => {
    mocks.project(props)
    return null
  },
}))

describe('section pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.router = { isReady: true, query: {} }
  })

  it.each([
    [undefined, { initialChatId: null, isLocalChatUrl: false }],
    [['c1'], { initialChatId: 'c1', isLocalChatUrl: false }],
    [['local', 'c2'], { initialChatId: 'c2', isLocalChatUrl: true }],
  ])('chat page routes slug %j', (slug, props) => {
    mocks.router.query = { slug }
    render(<ChatCatchAllPage />)
    expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(props)
  })

  it.each([
    [['p1'], { projectId: 'p1', chatId: null }],
    [['p1', 'chat', 'c3'], { projectId: 'p1', chatId: 'c3' }],
  ])('project page routes slug %j', (slug, props) => {
    mocks.router.query = { slug }
    render(<ProjectCatchAllPage />)
    expect(mocks.project).toHaveBeenCalledExactlyOnceWith(props)
  })

  it.each([
    ['chat', ChatCatchAllPage, mocks.chat],
    ['project', ProjectCatchAllPage, mocks.project],
  ])(
    '%s page shows the loader and mounts nothing before the router is ready',
    (_name, Page, target) => {
      mocks.router = { isReady: false, query: {} }
      render(<Page />)
      expect(
        screen.getByRole('status', { name: 'Loading route' }),
      ).toBeVisible()
      expect(target).not.toHaveBeenCalled()
    },
  )
})
