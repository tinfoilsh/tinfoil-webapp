import type {
  TimelineThinkingBlock,
  TimelineURLFetchBlock,
  TimelineWebSearchBlock,
} from '@/components/chat/types'
import { memo, useId, useMemo, useState, type ReactNode } from 'react'
import { formatDurationLabel } from './format-duration'
import { ThinkingLabel, ThoughtProcess } from './ThoughtProcess'
import {
  getURLFetchHeaderLabel,
  isAnyURLFetching,
  URLFetchProcess,
} from './URLFetchProcess'
import { WebSearchLabel, WebSearchProcess } from './WebSearchProcess'
import { StepDetails, StepHeader } from './WorkStep'

export type WorkBlock =
  TimelineThinkingBlock | TimelineWebSearchBlock | TimelineURLFetchBlock

interface WorkProcessProps {
  /** Consecutive trace blocks, in timeline order. */
  blocks: WorkBlock[]
  /** True while the stream is still inside this run (no answer text yet). */
  isActive: boolean
  isDarkMode: boolean
}

/**
 * Wall-clock span of the run from the stamps recorded while streaming.
 * Falls back to summed thinking durations for messages saved before
 * stamps existed; undefined when neither is available.
 */
export function getWorkDurationSeconds(
  blocks: WorkBlock[],
): number | undefined {
  let start = Infinity
  let end = -Infinity
  for (const block of blocks) {
    if (block.startedAt === undefined) continue
    start = Math.min(start, block.startedAt)
    end = Math.max(end, block.endedAt ?? block.startedAt)
  }
  if (start !== Infinity) return (end - start) / 1000

  let thinking = 0
  for (const block of blocks) {
    if (block.type === 'thinking' && block.duration) thinking += block.duration
  }
  return thinking > 0 ? thinking : undefined
}

type LiveActivity =
  | { kind: 'thinking'; block: TimelineThinkingBlock }
  | { kind: 'action'; label: ReactNode }
  | { kind: 'idle' }

function getLiveActivity(blocks: WorkBlock[]): LiveActivity {
  const last = blocks[blocks.length - 1]
  if (!last) return { kind: 'idle' }
  switch (last.type) {
    case 'thinking':
      return last.isThinking
        ? { kind: 'thinking', block: last }
        : { kind: 'idle' }
    case 'web_search':
      if (last.state.status !== 'searching') return { kind: 'idle' }
      return {
        kind: 'action',
        label: <WebSearchLabel webSearch={last.state} />,
      }
    case 'url_fetches':
      if (!isAnyURLFetching(last.fetches)) return { kind: 'idle' }
      return {
        kind: 'action',
        label: (
          <span className="font-medium">
            {getURLFetchHeaderLabel(last.fetches)}
          </span>
        ),
      }
  }
}

export const WorkProcess = memo(function WorkProcess({
  blocks,
  isActive,
  isDarkMode,
}: WorkProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()

  const activity = useMemo(
    () => (isActive ? getLiveActivity(blocks) : null),
    [blocks, isActive],
  )
  const activeThinking = activity?.kind === 'thinking' ? activity.block : null
  const summary = activeThinking?.summary ?? ''

  const duration = useMemo(
    () => (isActive ? undefined : getWorkDurationSeconds(blocks)),
    [blocks, isActive],
  )

  const stepsNoun = `${blocks.length} step${blocks.length === 1 ? '' : 's'}`

  return (
    <div>
      <StepHeader
        label={
          activity?.kind === 'thinking' ? (
            <ThinkingLabel summary={summary} isDarkMode={isDarkMode} />
          ) : activity?.kind === 'action' ? (
            activity.label
          ) : activity?.kind === 'idle' ? (
            <span className="font-medium">Working</span>
          ) : (
            <span>
              <span className="font-medium">Worked</span>
              <span className="font-normal">
                {duration !== undefined
                  ? ` for ${formatDurationLabel(duration)}`
                  : ` through ${stepsNoun}`}
              </span>
            </span>
          )
        }
        isRunning={isActive}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((v) => !v)}
        detailsId={detailsId}
      />

      <StepDetails
        id={detailsId}
        isExpanded={isExpanded}
        boxClassName="divide-y divide-border-subtle"
      >
        {blocks.map((block) => (
          <div key={block.id} className="px-3 py-1">
            {block.type === 'thinking' ? (
              <ThoughtProcess
                thoughts={block.content}
                isDarkMode={isDarkMode}
                isThinking={block.isThinking}
                thinkingDuration={block.duration}
                summary={block === activeThinking ? summary : ''}
                inGroup
              />
            ) : block.type === 'web_search' ? (
              <WebSearchProcess webSearch={block.state} inGroup />
            ) : (
              <URLFetchProcess urlFetches={block.fetches} inGroup />
            )}
          </div>
        ))}
      </StepDetails>
    </div>
  )
})
