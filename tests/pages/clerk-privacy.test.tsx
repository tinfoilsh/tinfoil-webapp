import App from '@/pages/_app'
import Document from '@/pages/_document'
import { Clerk } from '@clerk/clerk-js/no-rhc'
import { ui as clerkUi } from '@clerk/ui/no-rhc'
import { render } from '@testing-library/react'
import type { AppProps } from 'next/app'
import type { ScriptProps } from 'next/script'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Children, isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const clerkProvider = vi.hoisted(() => vi.fn((_props: unknown) => null))
const script = vi.hoisted(() => vi.fn((_props: ScriptProps) => null))

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
vi.mock('next/script', () => ({ default: script }))

function renderApp() {
  const appProps = {
    Component: () => null,
    pageProps: {},
    router: { pathname: '/signin', asPath: '/signin', isReady: true },
  } as unknown as AppProps
  return render(<App {...appProps} />)
}

function elementProps(node: ReactNode): Array<Record<string, unknown>> {
  if (!isValidElement(node)) return []

  const props = node.props as { children?: ReactNode }
  return [
    node.props as Record<string, unknown>,
    ...Children.toArray(props.children).flatMap(elementProps),
  ]
}

describe('Clerk privacy configuration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('bundles Clerk from npm and disables telemetry on the app-level provider', () => {
    renderApp()

    expect(clerkProvider).toHaveBeenCalledTimes(1)
    expect(clerkProvider.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        telemetry: false,
        Clerk,
        ui: clerkUi,
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

  it('matches the rendered analytics script integrity to the served asset', () => {
    renderApp()
    const analyticsScripts = script.mock.calls
      .map(([props]) => props)
      .filter(({ src }) => src === '/js/plausible.js')
    expect(analyticsScripts).toHaveLength(1)
    const asset = readFileSync(resolve(process.cwd(), 'public/js/plausible.js'))
    const digest = createHash('sha384').update(asset).digest('base64')
    expect(analyticsScripts[0]).toMatchObject({
      integrity: `sha384-${digest}`,
      crossOrigin: 'anonymous',
    })
  })
})
