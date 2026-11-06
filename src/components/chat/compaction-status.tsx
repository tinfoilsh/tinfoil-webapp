import { useId } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { COMPACTING_LABEL } from './renderers/components/CompactionMarker'

const COMPACTING_DETAIL =
  'This can take a minute or two. Messages you send now are sent once it is done.'

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
