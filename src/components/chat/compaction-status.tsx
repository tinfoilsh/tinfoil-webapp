import { TfBoxCheckmark, TfBoxX } from '@tinfoilsh/tinfoil-icons'
import { useId } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { COMPACTING_LABEL } from './renderers/components/CompactionMarker'

const COMPACTING_DETAIL =
  'This can take a minute or two. Messages you send now are sent once it is done.'
const COMPACTED_LABEL = 'Conversation compacted'

// Says the open chat is being compacted, above the composer and the messages
// queued behind the compaction, which send once it ends.
export function CompactionStatus() {
  const labelId = useId()
  return (
    <div role="status" aria-labelledby={labelId} className="mb-2 px-6 md:px-8">
      <div className="flex items-start gap-2 rounded-2xl border border-border-subtle bg-surface-chat px-3 py-2 shadow-sm">
        <PiSpinner
          className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-content-secondary"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <p id={labelId} className="text-sm font-medium text-content-primary">
            {COMPACTING_LABEL}
          </p>
          <p className="text-xs text-content-secondary">{COMPACTING_DETAIL}</p>
        </div>
      </div>
    </div>
  )
}

// Says the open chat was just compacted, where the status of its compaction
// showed: the chat's marker sits above earlier messages, often out of view.
export function CompactedNotice({
  messageCount,
  onShow,
  onDismiss,
}: {
  messageCount: number
  onShow: () => void
  onDismiss: () => void
}) {
  const labelId = useId()
  return (
    <div role="status" aria-labelledby={labelId} className="mb-2 px-6 md:px-8">
      <div className="flex items-start gap-2 rounded-2xl border border-border-subtle bg-surface-chat px-3 py-2 shadow-sm">
        <TfBoxCheckmark
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-secondary"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <p id={labelId} className="text-sm font-medium text-content-primary">
            {COMPACTED_LABEL}
          </p>
          <p className="text-xs text-content-secondary">
            {`Summarized ${messageCount} earlier ${messageCount === 1 ? 'message' : 'messages'}. The assistant now reads the summary in their place.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onShow}
          className="flex-shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
        >
          Show summary
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-chat-background hover:text-content-primary"
        >
          <TfBoxX className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
