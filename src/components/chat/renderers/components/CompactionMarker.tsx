import type { Compaction } from '@/components/chat/types'
import { cn } from '@/components/ui/utils'
import { memo, useId, useState } from 'react'
import { StepMarkdown } from './StepMarkdown'
import { StepDetails, StepHeader } from './WorkStep'

export const COMPACTING_LABEL = 'Compacting conversation'

type CompactionMarkerProps = Omit<Compaction, 'id'> & {
  // A marker before the chat's latest one, whose summary the model no longer
  // reads either.
  outOfContext?: boolean
}

// Where the messages above were summarized for the model, which reads the
// summary in their place. It opens to show the summary once written.
export const CompactionMarker = memo(function CompactionMarker({
  isRunning,
  summary,
  messageCount,
  startedAt,
  outOfContext = false,
}: CompactionMarkerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  return (
    <div
      role="note"
      aria-label={
        isRunning
          ? 'Earlier messages above are being summarized for the assistant'
          : 'Earlier messages above were summarized and are no longer read by the assistant'
      }
      data-out-of-context={outOfContext || undefined}
      className={cn(
        'no-scroll-anchoring mx-auto mb-6 w-full max-w-3xl px-4',
        outOfContext && 'opacity-50',
      )}
    >
      <StepHeader
        label={
          <span className="font-medium">
            {isRunning
              ? COMPACTING_LABEL
              : `Compacted ${messageCount} earlier ${messageCount === 1 ? 'message' : 'messages'}`}
          </span>
        }
        isRunning={isRunning}
        startedAt={startedAt}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((expanded) => !expanded)}
        detailsId={isRunning ? undefined : detailsId}
      />
      {!isRunning && (
        <StepDetails id={detailsId} isExpanded={isExpanded}>
          <div className="prose prose-sm max-w-none text-content-primary dark:prose-invert">
            <StepMarkdown content={summary} />
          </div>
          <p className="mt-2 text-xs text-content-muted">
            The assistant now reads this summary instead of the messages above.
          </p>
        </StepDetails>
      )}
    </div>
  )
})
