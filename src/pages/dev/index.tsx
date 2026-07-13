'use client'

import { IS_DEV } from '@/config'
import Head from 'next/head'
import Link from 'next/link'
import { useEffect, useState } from 'react'

/**
 * Dev-only index listing the available flow simulator pages.
 *
 * Available at /dev when running `next dev` (or a NEXT_PUBLIC_DEV=true
 * build served from localhost).
 */

const DEV_PAGES = [
  {
    href: '/dev/onboarding-flow',
    title: 'Onboarding Flow Simulator',
    description:
      'Renders the full-page onboarding view with a stubbed completion callback. Nothing is written to localStorage or Clerk metadata.',
  },
  {
    href: '/dev/cloud-sync-flows',
    title: 'Cloud Sync Flow Simulator',
    description:
      'Triggers every cloud-sync popup start state with stubbed callbacks. Nothing talks to the enclave or your account.',
  },
]

export default function DevIndexPage() {
  const [harnessEnabled, setHarnessEnabled] = useState(false)

  useEffect(() => {
    // Runtime gate is evaluated on the client so static-export builds
    // and dev servers behave identically (and to avoid SSR hydration
    // mismatches).
    setHarnessEnabled(process.env.NODE_ENV === 'development' || IS_DEV)
  }, [])

  if (!harnessEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-chat-background font-aeonik text-content-primary">
        <p className="text-sm text-content-secondary">
          This page is only available in local dev mode.
        </p>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Dev Pages</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="min-h-screen bg-surface-chat-background p-6 font-aeonik text-content-primary">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Dev Pages</h1>
            <p className="mt-1 text-sm text-content-secondary">
              Local-only harnesses for exercising app flows with stubbed
              callbacks.
            </p>
          </div>

          <div className="space-y-2">
            {DEV_PAGES.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className="block w-full rounded-lg border border-border-subtle bg-surface-card p-4 text-left transition-colors hover:bg-surface-chat"
              >
                <div className="text-sm font-semibold">{page.title}</div>
                <div className="mt-1 text-xs text-content-secondary">
                  {page.description}
                </div>
                <div className="mt-2 font-mono text-xs text-content-muted">
                  {page.href}
                </div>
              </Link>
            ))}
          </div>

          <Link
            href="/"
            className="inline-block text-sm text-content-secondary transition-colors hover:text-content-primary"
          >
            Back to chat
          </Link>
        </div>
      </div>
    </>
  )
}
