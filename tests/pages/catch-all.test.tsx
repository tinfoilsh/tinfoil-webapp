import CatchAllPage from '@/pages/[...slug]'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  router: { isReady: true, query: {} as { slug?: string | string[] } },
  chat: vi.fn(),
  project: vi.fn(),
  share: vi.fn(),
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
vi.mock('@/components/share/share-page', () => ({
  default: (props: unknown) => {
    mocks.share(props)
    return null
  },
}))

describe('CatchAllPage', () => {
  it.each([
    [['chat'], mocks.chat, { initialChatId: null, isLocalChatUrl: false }],
    [
      ['chat', 'c1'],
      mocks.chat,
      { initialChatId: 'c1', isLocalChatUrl: false },
    ],
    [
      ['chat', 'local', 'c2'],
      mocks.chat,
      { initialChatId: 'c2', isLocalChatUrl: true },
    ],
    [['project', 'p1'], mocks.project, { projectId: 'p1', chatId: null }],
    [
      ['project', 'p1', 'chat', 'c3'],
      mocks.project,
      { projectId: 'p1', chatId: 'c3' },
    ],
    [['share', 's1'], mocks.share, { chatId: 's1' }],
  ])('routes %j to the right view', (slug, target, props) => {
    mocks.router.query = { slug }
    render(<CatchAllPage />)
    expect(target).toHaveBeenCalledWith(props)
  })

  it('renders 404 for an unknown section', () => {
    mocks.router.query = { slug: ['nope'] }
    render(<CatchAllPage />)
    expect(screen.getByText('Page not found')).toBeInTheDocument()
  })

  it('renders nothing route-specific before the router is ready', () => {
    mocks.router = { isReady: false, query: {} }
    const { container } = render(<CatchAllPage />)
    expect(container.textContent).toBe('')
  })
})
