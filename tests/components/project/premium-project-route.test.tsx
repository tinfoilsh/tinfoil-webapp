import { PremiumProjectRoute } from '@/components/project/premium-project-route'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isLoading: false,
  subscriptionActive: false,
  router: {
    isReady: true,
    replace: vi.fn(),
  },
}))

vi.mock('next/router', () => ({
  useRouter: () => mocks.router,
}))

vi.mock('@/hooks/use-subscription-status', () => ({
  useSubscriptionStatus: () => ({
    isLoading: mocks.isLoading,
    chat_subscription_active: mocks.subscriptionActive,
  }),
}))

vi.mock('@/components/project/project-provider', () => ({
  ProjectProvider: ({
    children,
    initialProjectId,
  }: {
    children: ReactNode
    initialProjectId?: string | null
  }) => (
    <div data-testid="project-provider" data-project-id={initialProjectId}>
      {children}
    </div>
  ),
}))

vi.mock('@/components/chat', () => ({
  ChatInterface: ({
    initialProjectId,
    initialChatId,
  }: {
    initialProjectId?: string | null
    initialChatId?: string | null
  }) => (
    <div
      data-testid="project-chat"
      data-project-id={initialProjectId}
      data-chat-id={initialChatId}
    >
      Project chat
    </div>
  ),
}))

describe('PremiumProjectRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLoading = false
    mocks.subscriptionActive = false
    mocks.router.isReady = true
  })

  it('redirects free users to chat with the upgrade prompt marker', () => {
    render(<PremiumProjectRoute projectId="project-1" />)

    expect(mocks.router.replace).toHaveBeenCalledWith('/chat?upgrade=projects')
    expect(screen.queryByText('Project chat')).not.toBeInTheDocument()
  })

  it('renders project chat for Premium users', () => {
    mocks.subscriptionActive = true
    render(<PremiumProjectRoute projectId="project-1" chatId="chat-2" />)

    expect(screen.getByText('Project chat')).toBeInTheDocument()
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-provider')).toHaveAttribute(
      'data-project-id',
      'project-1',
    )
    expect(screen.getByTestId('project-chat')).toHaveAttribute(
      'data-project-id',
      'project-1',
    )
    expect(screen.getByTestId('project-chat')).toHaveAttribute(
      'data-chat-id',
      'chat-2',
    )
  })

  it.each([false, true])(
    'does not render or redirect while subscription status is loading (cached Premium: %s)',
    (active) => {
      mocks.isLoading = true
      mocks.subscriptionActive = active
      const view = render(<PremiumProjectRoute projectId="project-1" />)

      expect(screen.queryByText('Project chat')).not.toBeInTheDocument()
      expect(mocks.router.replace).not.toHaveBeenCalled()
      mocks.isLoading = false
      view.rerender(<PremiumProjectRoute projectId="project-1" />)
      if (active) {
        expect(screen.getByText('Project chat')).toBeInTheDocument()
        expect(mocks.router.replace).not.toHaveBeenCalled()
      } else {
        expect(screen.queryByText('Project chat')).not.toBeInTheDocument()
        expect(mocks.router.replace).toHaveBeenCalledExactlyOnceWith(
          '/chat?upgrade=projects',
        )
      }
    },
  )

  it('does not render project chat before route parameters are ready', () => {
    mocks.subscriptionActive = true
    mocks.router.isReady = false
    render(<PremiumProjectRoute projectId={null} />)

    expect(screen.queryByText('Project chat')).not.toBeInTheDocument()
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })

  it('redirects a free user when the router becomes ready', () => {
    mocks.router.isReady = false
    const view = render(<PremiumProjectRoute projectId={null} />)
    expect(mocks.router.replace).not.toHaveBeenCalled()

    mocks.router.isReady = true
    view.rerender(<PremiumProjectRoute projectId={null} />)

    expect(mocks.router.replace).toHaveBeenCalledWith('/chat?upgrade=projects')
  })
})
