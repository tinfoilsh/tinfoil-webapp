import { cn } from '@/components/ui/utils'
import { TrashIcon } from '@heroicons/react/24/outline'
import { HiOutlineQueueList } from 'react-icons/hi2'
import type { QueuedMessage } from './types'

const QUEUED_PREVIEW_MAX_LENGTH = 240

type MessageQueueProps = {
  queue: QueuedMessage[]
  onRemove: (id: string) => void
}

export function MessageQueue({ queue, onRemove }: MessageQueueProps) {
  if (queue.length === 0) return null

  return (
    <div className="mb-2 flex flex-col items-center gap-1.5 px-6 md:px-8">
      {queue.map((item) => {
        const previewText = item.text.trim()
        const truncated =
          previewText.length > QUEUED_PREVIEW_MAX_LENGTH
            ? `${previewText.slice(0, QUEUED_PREVIEW_MAX_LENGTH).trimEnd()}…`
            : previewText
        const attachmentCount = item.attachments?.length ?? 0
        const hasQuote = Boolean(item.quote)
        const fallbackLabel =
          attachmentCount > 0
            ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
            : hasQuote
              ? 'Quoted reply'
              : 'Queued message'

        return (
          <div
            key={item.id}
            className={cn(
              'group flex w-full items-start gap-2 rounded-2xl border border-border-subtle bg-surface-chat px-3 py-2 shadow-sm',
            )}
          >
            <HiOutlineQueueList className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-secondary" />
            <p className="line-clamp-2 flex-1 whitespace-pre-wrap break-words text-sm text-content-secondary">
              {truncated || fallbackLabel}
            </p>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label="Remove queued message"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
