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

  it('starts a routed local new chat in local-only mode', () => {
    mocks.router.query = { storage: 'local' }

    render(<NewChatPage />)

    expect(mocks.chatInterface).toHaveBeenCalledWith(
      expect.objectContaining({ initialNewChatIsLocalOnly: true }),
    )
  })

  it('uses cloud mode for the default new-chat destination', () => {
    render(<NewChatPage />)

    expect(mocks.chatInterface).toHaveBeenCalledWith(
      expect.objectContaining({ initialNewChatIsLocalOnly: false }),
    )
  })
})
