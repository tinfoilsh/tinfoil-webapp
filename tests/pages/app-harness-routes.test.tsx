import App from '@/pages/_app'
import { render, screen } from '@testing-library/react'
import type { AppProps } from 'next/app'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/services/harness/provider', () => ({
  HarnessProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="harness">{children}</div>
  ),
}))
vi.mock('@/components/auth-cleanup-handler', () => ({
  AuthCleanupHandler: () => null,
}))
vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  useChatFontSync: vi.fn(),
}))
vi.mock('@/components/signout-progress-overlay', () => ({
  SignoutProgressOverlay: () => null,
}))
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }))
vi.mock('@/utils/storage-migration', () => ({ migrateStorageKeys: vi.fn() }))
vi.mock('next/font/local', () => ({
  default: () => ({
    style: { fontFamily: 'test-font' },
    variable: 'test-font-variable',
  }),
}))
vi.mock('next/head', () => ({ default: () => null }))
vi.mock('next/script', () => ({ default: () => null }))

describe('the chat service around pages', () => {
  it.each([
    { pathname: '/', asPath: '/', wrapped: true },
    { pathname: '/chat/[[...slug]]', asPath: '/chat/c1', wrapped: true },
    { pathname: '/project/[[...slug]]', asPath: '/project/p1', wrapped: true },
    { pathname: '/share/[[...slug]]', asPath: '/share/s1', wrapped: true },
    { pathname: '/404', asPath: '/no-such-page', wrapped: false },
    { pathname: '/signin', asPath: '/signin', wrapped: false },
  ])('wraps $asPath: $wrapped', ({ pathname, asPath, wrapped }) => {
    const router = {
      pathname,
      asPath,
      query: {},
      isReady: true,
    }
    render(
      <App
        Component={() => <main>Page</main>}
        pageProps={{}}
        router={router as unknown as AppProps['router']}
      />,
    )

    expect(screen.getByRole('main')).toHaveTextContent('Page')
    expect(screen.queryByTestId('harness') !== null).toBe(wrapped)
  })
})
