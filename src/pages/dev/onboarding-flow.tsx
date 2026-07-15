'use client'

import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { IS_DEV } from '@/config'
import { AnimatePresence } from 'framer-motion'
import Head from 'next/head'
import { useCallback, useEffect, useState } from 'react'

/**
 * Dev-only harness for exercising the first-open onboarding flow
 * without clearing local state. The view is rendered with
 * persistCompletion=false, so completing it never writes the
 * seen-onboarding flag to localStorage or Clerk unsafeMetadata.
 *
 * Available at /dev/onboarding-flow when running `next dev` (or a
 * NEXT_PUBLIC_DEV=true build served from localhost).
 */

interface LogEntry {
  time: string
  message: string
}

export default function OnboardingFlowDevPage() {
  const [harnessEnabled, setHarnessEnabled] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [runId, setRunId] = useState(0)
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    // Runtime gate is evaluated on the client so static-export builds
    // and dev servers behave identically (and to avoid SSR hydration
    // mismatches).
    setHarnessEnabled(process.env.NODE_ENV === 'development' || IS_DEV)
  }, [])

  const appendLog = useCallback((message: string) => {
    setLog((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), message },
    ])
  }, [])

  const openOnboarding = useCallback(() => {
    setRunId((id) => id + 1)
    setIsOpen(true)
    appendLog('--- opened onboarding ---')
  }, [appendLog])

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
        <title>Onboarding Flow Simulator</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="min-h-screen bg-surface-chat-background p-6 font-aeonik text-content-primary">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Onboarding Flow Simulator</h1>
            <p className="mt-1 text-sm text-content-secondary">
              Renders the full-page onboarding view with a stubbed completion
              callback. Nothing is written to localStorage or Clerk metadata, so
              your local and account state are untouched.
            </p>
          </div>

          <button
            onClick={openOnboarding}
            className="w-full rounded-lg border border-border-subtle bg-surface-card p-4 text-left transition-colors hover:bg-surface-chat"
          >
            <div className="text-sm font-semibold">Open onboarding</div>
            <div className="mt-1 text-xs text-content-secondary">
              Two-page flow: letter from the founders, then the privacy switch.
              Completing it just logs the result below.
            </div>
          </button>

          <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Event log</h2>
              <button
                onClick={() => setLog([])}
                className="text-xs text-content-muted hover:text-content-secondary"
              >
                Clear
              </button>
            </div>
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs text-content-secondary">
              {log.length === 0 && (
                <p className="text-content-muted">No events yet.</p>
              )}
              {log.map((entry, i) => (
                <div key={i}>
                  <span className="text-content-muted">{entry.time}</span>{' '}
                  {entry.message}
                </div>
              ))}
            </div>
          </div>
        </div>

        <AnimatePresence>
          {isOpen && (
            <OnboardingView
              key={runId}
              persistCompletion={false}
              onComplete={() => {
                appendLog('onComplete()')
                setIsOpen(false)
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
