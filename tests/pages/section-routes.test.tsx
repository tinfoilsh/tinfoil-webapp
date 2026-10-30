import ChatCatchAllPage from '@/pages/chat/[[...slug]]'
import ProjectCatchAllPage from '@/pages/project/[[...slug]]'
import ShareCatchAllPage from '@/pages/share/[[...slug]]'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  router: {
    pathname: '/',
    isReady: true,
    query: {} as { slug?: string | string[] },
  },
  chat: vi.fn(),
  project: vi.fn(),
  share: vi.fn(),
}))

vi.mock('next/router', () => ({ useRouter: () => mocks.router }))
vi.mock('@/components/ui/logo-loading', () => ({
  LogoLoading: () => <div role="status" aria-label="Loading route" />,
}))
vi.mock('@/components/chat/chat-route', () => ({
  ChatRoute: (props: { projectRoute?: boolean }) => {
    if (props.projectRoute === false) mocks.chat(props)
    else mocks.project(props)
    return null
  },
}))
vi.mock('@/components/share/share-page', () => ({
  default: (props: unknown) => {
    mocks.share(props)
    return null
  },
}))

describe('section pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.router = { pathname: '/', isReady: true, query: {} }
  })

  it.each([
    [
      undefined,
      {
        projectRoute: false,
        projectId: null,
        chatId: null,
        isLocalChatUrl: false,
      },
    ],
    [
      ['c1'],
      {
        projectRoute: false,
        projectId: null,
        chatId: 'c1',
        isLocalChatUrl: false,
      },
    ],
    [
      ['local', 'c2'],
      {
        projectRoute: false,
        projectId: null,
        chatId: 'c2',
        isLocalChatUrl: true,
      },
    ],
  ])('chat page routes slug %j', (slug, props) => {
    mocks.router = {
      pathname: '/chat/[[...slug]]',
      isReady: true,
      query: { slug },
    }
    render(<ChatCatchAllPage />)
    expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(props)
    expect(mocks.project).not.toHaveBeenCalled()
  })

  it.each([
    [['p1'], { projectId: 'p1', chatId: null }],
    [['p1', 'chat', 'c3'], { projectId: 'p1', chatId: 'c3' }],
  ])('project page routes slug %j', (slug, props) => {
    mocks.router = {
      pathname: '/project/[[...slug]]',
      isReady: true,
      query: { slug },
    }
    render(<ProjectCatchAllPage />)
    expect(mocks.project).toHaveBeenCalledExactlyOnceWith(props)
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, { chatId: undefined }],
    [['s1'], { chatId: 's1' }],
  ])('share page routes slug %j', (slug, props) => {
    mocks.router = {
      pathname: '/share/[[...slug]]',
      isReady: true,
      query: { slug },
    }
    render(<ShareCatchAllPage />)
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(props)
  })

  it.each([
    ['chat', ChatCatchAllPage, mocks.chat],
    ['project', ProjectCatchAllPage, mocks.project],
    ['share', ShareCatchAllPage, mocks.share],
  ])(
    '%s page shows the loader and mounts nothing before the router is ready',
    (name, Page, target) => {
      mocks.router = {
        pathname: `/${name}/[[...slug]]`,
        isReady: false,
        query: {},
      }
      render(<Page />)
      expect(
        screen.getByRole('status', { name: 'Loading route' }),
      ).toBeVisible()
      expect(target).not.toHaveBeenCalled()
    },
  )
})
