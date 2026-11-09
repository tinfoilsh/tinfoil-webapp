import type { IconType } from '@tinfoilsh/tinfoil-icons'
import type { ReactNode } from 'react'

// Takes the place of the whole page while the chat cannot be used, and says
// what the user can do about it.
export function PageNotice({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: IconType
  title: string
  children: ReactNode
  action?: { label: string; onClick(): void }
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-surface-chat-background px-4 font-aeonik">
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <Icon
            className="h-24 w-24 !text-content-secondary"
            aria-hidden="true"
          />
        </div>
        <h2 className="mb-3 text-xl font-semibold text-content-primary">
          {title}
        </h2>
        <p role="alert" className="mb-6 text-content-secondary">
          {children}
        </p>
        {action && (
          <button
            onClick={action.onClick}
            className="rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
