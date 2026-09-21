import App from '@/pages/_app'
import Document from '@/pages/_document'
import { render } from '@testing-library/react'
import type { AppProps } from 'next/app'
import { Children, isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const clerkProvider = vi.hoisted(() => vi.fn((_props: unknown) => null))

vi.mock('@clerk/react', () => ({ ClerkProvider: clerkProvider }))
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

function elementProps(node: ReactNode): Array<Record<string, unknown>> {
  if (!isValidElement(node)) return []

  const props = node.props as { children?: ReactNode }
  return [
    node.props as Record<string, unknown>,
    ...Children.toArray(props.children).flatMap(elementProps),
  ]
}

describe('Clerk privacy configuration', () => {
  it('bundles Clerk from npm and disables telemetry on the app-level provider', () => {
    const Component = () => null
    const appProps = {
      Component,
      pageProps: {},
      router: { pathname: '/' },
    } as unknown as AppProps

    render(<App {...appProps} />)

    expect(clerkProvider.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        telemetry: false,
        Clerk: expect.any(Function),
        ui: expect.objectContaining({ ClerkUI: expect.any(Function) }),
      }),
    )
  })

  it('does not preconnect to the stale Clerk development host', () => {
    expect(elementProps(Document())).not.toContainEqual(
      expect.objectContaining({
        href: 'https://clerk.accounts.dev',
        rel: 'preconnect',
      }),
    )
  })
})
