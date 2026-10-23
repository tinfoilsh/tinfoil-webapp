import { postAuthRedirectTarget } from '@/utils/redirect-url'
import Link from 'next/link'

export type ChatHistoryProblem = 'sign-in' | 'unlock' | 'not-found' | 'failed'

const descriptions = {
  'sign-in': ['Sign in required', 'You need to sign in to access this chat.'],
  unlock: [
    'Unlock chat history',
    'Unlock your encryption key to access this chat.',
  ],
  'not-found': [
    'Chat not found',
    'This chat may have been deleted or is no longer available.',
  ],
  failed: [
    "Couldn't load chat",
    'The chat could not be loaded. Please try again.',
  ],
} as const

const ACTION_CLASS_NAME =
  'rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white hover:bg-brand-accent-dark/90'

export function ChatHistoryStatus({
  problem,
  path,
  error,
  onRetry,
  onUnlock,
  onNewChat,
}: {
  problem: ChatHistoryProblem
  path: string
  error?: string
  onRetry(): void
  onUnlock(): void
  onNewChat(): void
}) {
  const [title, description] = descriptions[problem]
  return (
    <section
      className="flex min-h-full flex-1 items-center justify-center px-4"
      aria-label="Chat history unavailable"
    >
      <div className="max-w-md text-center">
        <h2 className="mb-3 text-xl font-semibold text-content-primary">
          {title}
        </h2>
        <p role="alert" className="mb-6 text-content-secondary">
          {problem === 'failed' && error ? error : description}
        </p>
        {problem === 'sign-in' ? (
          <Link
            href={`/signin?redirect_url=${postAuthRedirectTarget(path)}`}
            className={ACTION_CLASS_NAME}
          >
            Sign in
          </Link>
        ) : (
          <button
            type="button"
            className={ACTION_CLASS_NAME}
            onClick={
              problem === 'unlock'
                ? onUnlock
                : problem === 'not-found'
                  ? onNewChat
                  : onRetry
            }
          >
            {problem === 'unlock'
              ? 'Unlock'
              : problem === 'not-found'
                ? 'Start a new chat'
                : 'Try again'}
          </button>
        )}
      </div>
    </section>
  )
}
