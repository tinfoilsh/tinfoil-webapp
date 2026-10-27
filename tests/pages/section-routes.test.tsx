import ChatCatchAllPage from '@/pages/chat/[[...slug]]'
import ProjectCatchAllPage from '@/pages/project/[[...slug]]'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  router: { isReady: true, query: {} as { slug?: string | string[] } },
  chat: vi.fn(),
  project: vi.fn(),
}))

vi.mock('next/router', () => ({ useRouter: () => mocks.router }))
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
  it.each([
    [undefined, { initialChatId: null, isLocalChatUrl: false }],
    [['c1'], { initialChatId: 'c1', isLocalChatUrl: false }],
    [['local', 'c2'], { initialChatId: 'c2', isLocalChatUrl: true }],
  ])('chat page routes slug %j', (slug, props) => {
    mocks.router.query = { slug }
    render(<ChatCatchAllPage />)
    expect(mocks.chat).toHaveBeenCalledWith(props)
  })

  it.each([
    [['p1'], { projectId: 'p1', chatId: null }],
    [['p1', 'chat', 'c3'], { projectId: 'p1', chatId: 'c3' }],
  ])('project page routes slug %j', (slug, props) => {
    mocks.router.query = { slug }
    render(<ProjectCatchAllPage />)
    expect(mocks.project).toHaveBeenCalledWith(props)
  })
})
