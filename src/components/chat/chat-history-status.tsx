import { cn } from '@/components/ui/utils'
import { postAuthRedirectTarget } from '@/utils/redirect-url'
import { TfTinSad } from '@tinfoilsh/tinfoil-icons'
import {
  TfChat2Animated,
  TfLockLockedAnimated,
  TfPersonAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import Link from 'next/link'

export type ChatHistoryProblem =
  'sign-in' | 'unlock' | 'wrong-key' | 'not-found' | 'failed'

const descriptions = {
  'sign-in': ['Sign in required', 'You need to sign in to access this chat.'],
  unlock: [
    'Unlock chat history',
    'Unlock your encryption key to access this chat.',
  ],
  'wrong-key': [
    'Unable to decrypt chat',
    'This chat was encrypted with a different key. You can update the key in settings.',
  ],
  'not-found': [
    'Chat not found',
    'This chat may have been deleted or is no longer available.',
  ],
  failed: [
    "Couldn't load chat",
    'A network error occurred while loading this chat. Please try again.',
  ],
} as const

const LOCAL_NOT_FOUND_DESCRIPTION =
  'This local chat may have been deleted from your browser.'

const icons = {
  'sign-in': TfPersonAnimated,
  unlock: TfLockLockedAnimated,
  'wrong-key': TfLockLockedAnimated,
  'not-found': TfChat2Animated,
  failed: TfTinSad,
} as const

const ACTION_CLASS_NAME =
  'rounded-lg bg-brand-accent-dark px-6 py-2.5 text-white hover:bg-brand-accent-dark/90'
const SECONDARY_ACTION_CLASS_NAME =
  'rounded-lg border border-border-subtle px-6 py-2.5 text-content-primary transition-colors hover:bg-surface-chat'

export function ChatHistoryStatus({
  problem,
  path,
  local,
  onRetry,
  onUnlock,
  onNewChat,
}: {
  problem: ChatHistoryProblem
  path: string
  // The chat was looked for among the chats this browser keeps.
  local: boolean
  onRetry(): void
  onUnlock(): void
  onNewChat(): void
}) {
  const [title, description] = descriptions[problem]
  const Icon = icons[problem]
  const isKeyProblem = problem === 'unlock' || problem === 'wrong-key'
  return (
    <section
      className="flex min-h-full flex-1 items-center justify-center px-4"
      aria-label="Chat history unavailable"
    >
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <div className="rounded-full bg-surface-chat p-4">
            <Icon
              className={cn(
                'h-8 w-8',
                isKeyProblem ? '!text-orange-500' : '!text-content-secondary',
              )}
              aria-hidden="true"
            />
          </div>
        </div>
        <h2 className="mb-3 text-xl font-semibold text-content-primary">
          {title}
        </h2>
        <p role="alert" className="mb-6 text-content-secondary">
          {problem === 'not-found' && local
            ? LOCAL_NOT_FOUND_DESCRIPTION
            : description}
        </p>
        {problem === 'sign-in' ? (
          <Link
            href={`/signin?redirect_url=${postAuthRedirectTarget(path)}`}
            className={ACTION_CLASS_NAME}
          >
            Sign in
          </Link>
        ) : (
          <div className="flex justify-center gap-3">
            <button
              type="button"
              className={ACTION_CLASS_NAME}
              onClick={
                isKeyProblem
                  ? onUnlock
                  : problem === 'not-found'
                    ? onNewChat
                    : onRetry
              }
            >
              {isKeyProblem
                ? 'Unlock'
                : problem === 'not-found'
                  ? 'Start new chat'
                  : 'Try again'}
            </button>
            {problem === 'failed' && (
              <button
                type="button"
                className={SECONDARY_ACTION_CLASS_NAME}
                onClick={onNewChat}
              >
                Start new chat
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
