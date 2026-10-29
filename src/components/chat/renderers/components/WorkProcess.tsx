import type {
  TimelineThinkingBlock,
  TimelineURLFetchBlock,
  TimelineWebSearchBlock,
} from '@/components/chat/types'
import { memo, useId, useMemo, useState, type ReactNode } from 'react'
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

const ACTION_LIST = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
})

const pagesNoun = (count: number) => (count === 1 ? 'a page' : `${count} pages`)

// What the steps did, in the order each kind first appears, as "Thought,
// searched the web, and read 3 pages". Pages read count across the steps.
function describeWork(blocks: WorkBlock[]): string {
  const fetches = blocks.flatMap((block) =>
    block.type === 'url_fetches' ? block.fetches : [],
  )
  const pagesRead = fetches.filter(
    (fetch) => fetch.status === 'completed',
  ).length
  const actions = new Map<WorkBlock['type'], string>()
  for (const block of blocks) {
    if (actions.has(block.type)) continue
    actions.set(
      block.type,
      block.type === 'thinking'
        ? 'thought'
        : block.type === 'web_search'
          ? 'searched the web'
          : pagesRead > 0
            ? `read ${pagesNoun(pagesRead)}`
            : `tried to read ${pagesNoun(fetches.length)}`,
    )
  }
  const description = ACTION_LIST.format(actions.values())
  return description.charAt(0).toUpperCase() + description.slice(1)
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

  const description = useMemo(() => describeWork(blocks), [blocks])
  const startedAt = useMemo(() => {
    const starts = blocks.flatMap((block) =>
      block.startedAt === undefined ? [] : [block.startedAt],
    )
    return starts.length > 0 ? Math.min(...starts) : undefined
  }, [blocks])

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
            <span className="font-medium">{description}</span>
          )
        }
        isRunning={isActive}
        startedAt={startedAt}
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
                startedAt={block.startedAt}
                summary={block === activeThinking ? summary : ''}
                inGroup
              />
            ) : block.type === 'web_search' ? (
              <WebSearchProcess
                webSearch={block.state}
                startedAt={block.startedAt}
                inGroup
              />
            ) : (
              <URLFetchProcess
                urlFetches={block.fetches}
                startedAt={block.startedAt}
                inGroup
              />
            )}
          </div>
        ))}
      </StepDetails>
    </div>
  )
})
