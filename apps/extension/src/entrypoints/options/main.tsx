import { ToggleSwitch } from '@tinfoil/chat-ui/toggle-switch'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { reviewActions, useSetting } from '../../settings'
import { Logo } from '../../ui/logo'
import '../../ui/styles'
import { useDarkMode } from '../../ui/theme'

const REVIEW_ACTIONS_LABEL = 'Review actions before execution'

function Settings() {
  const isDarkMode = useDarkMode()
  const [review, setReview] = useSetting(reviewActions)
  return (
    <div className="min-h-dvh bg-surface-sidebar font-aeonik text-content-primary">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-3 px-6">
          <Logo className="h-6 w-auto" dark={isDarkMode} />
          <h1 className="font-aeonik text-lg font-semibold text-content-primary">
            Settings
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <div className="space-y-3">
          <h2 className="font-aeonik text-sm font-medium text-content-secondary">
            Browser actions
          </h2>
          <div className="rounded-lg border border-border-subtle bg-white p-4 dark:bg-surface-sidebar">
            <div className="flex items-start justify-between">
              <div className="mr-3 flex-1">
                <div className="font-aeonik text-sm font-medium text-content-primary">
                  {REVIEW_ACTIONS_LABEL}
                </div>
                <div className="font-aeonik-fono text-xs text-content-muted">
                  Tinfoil asks before it clicks, types, or opens a page. When
                  off, it acts as soon as it decides to.
                </div>
              </div>
              <ToggleSwitch
                aria-label={REVIEW_ACTIONS_LABEL}
                checked={review ?? false}
                disabled={review === undefined}
                onChange={setReview}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
)
