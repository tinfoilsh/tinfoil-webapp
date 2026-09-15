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
  ProjectProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/components/chat', () => ({
  ChatInterface: () => <div>Project chat</div>,
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
    render(<PremiumProjectRoute projectId="project-1" />)

    expect(screen.getByText('Project chat')).toBeInTheDocument()
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })

  it('does not render or redirect while subscription status is loading', () => {
    mocks.isLoading = true
    render(<PremiumProjectRoute projectId="project-1" />)

    expect(screen.queryByText('Project chat')).not.toBeInTheDocument()
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })

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
