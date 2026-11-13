import { TfLockLockedAnimated } from '@tinfoilsh/tinfoil-icons/animated'
import { cn } from './utils'

// How a message's Markdown shows.
export const MESSAGE_PROSE_CLASS_NAME = cn(
  'prose w-full max-w-none text-base prose-pre:bg-transparent prose-pre:p-0',
  'text-content-primary prose-headings:text-content-primary prose-strong:text-content-primary prose-code:text-content-primary',
  'prose-a:text-blue-500 hover:prose-a:text-blue-600',
)

// The bubble a question shows in.
export const USER_MESSAGE_BUBBLE_CLASS_NAME =
  'rounded-site-lg bg-surface-message-user/90 px-4 py-2 shadow-sm backdrop-blur-sm'

// The model that wrote a reply, and that the reply was encrypted.
export const MessageMetadata = ({
  modelDisplayName,
}: {
  modelDisplayName?: string
}) => (
  <div className="flex shrink-0 items-center gap-1.5 text-xs text-content-muted">
    {modelDisplayName && (
      <>
        <span>{modelDisplayName}</span>
        <span aria-hidden="true">·</span>
      </>
    )}
    <span className="flex items-center gap-1 text-[10px]">
      <TfLockLockedAnimated className="h-3 w-3" aria-hidden="true" />
      Encrypted
    </span>
  </div>
)
