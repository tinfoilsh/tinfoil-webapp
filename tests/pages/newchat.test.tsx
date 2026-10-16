import NewChatPage from '@/pages/newchat'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chatInterface: vi.fn(),
  router: {
    isReady: true,
    query: {} as Record<string, string | string[] | undefined>,
  },
}))

vi.mock('next/router', () => ({
  useRouter: () => mocks.router,
}))

vi.mock('@/components/chat', () => ({
  ChatInterface: (props: Record<string, unknown>) => {
    mocks.chatInterface(props)
    return null
  },
}))

vi.mock('@/components/project', () => ({
  ProjectProvider: ({ children }: { children: ReactNode }) => children,
}))

describe('NewChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.router.isReady = true
    mocks.router.query = {}
  })

  it.each([
    [{ storage: 'local' }, true],
    [{}, false],
  ])(
    'starts a routed new chat for %j with local-only mode %s',
    (query, localOnly) => {
      mocks.router.query = query

      render(<NewChatPage />)

      expect(mocks.chatInterface).toHaveBeenCalledWith(
        expect.objectContaining({ initialNewChatIsLocalOnly: localOnly }),
      )
    },
  )
})
