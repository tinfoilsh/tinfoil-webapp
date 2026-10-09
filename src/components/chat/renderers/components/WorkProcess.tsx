import type {
  TimelineCodeExecBlock,
  TimelineThinkingBlock,
  TimelineURLFetchBlock,
  TimelineWebSearchBlock,
} from '@/components/chat/types'
import { LoadingDots } from '@/components/loading-dots'
import { memo, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { CodeExecProcess, getCodeExecHeaderLabel } from './CodeExecProcess'
import { formatDurationLabel } from './format-duration'
import { ThoughtProcess } from './ThoughtProcess'
import {
  getURLFetchHeaderLabel,
  isAnyURLFetching,
  URLFetchProcess,
} from './URLFetchProcess'
import { useThoughtSummary } from './use-thought-summary'
import { WebSearchProcess } from './WebSearchProcess'

export type WorkBlock =
  | TimelineThinkingBlock
  | TimelineWebSearchBlock
  | TimelineURLFetchBlock
  | TimelineCodeExecBlock

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
  | { kind: 'action'; label: string }
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
        label: last.state.query
          ? `Searching the web for "${last.state.query}"`
          : 'Searching the web',
      }
    case 'url_fetches':
      if (!isAnyURLFetching(last.fetches)) return { kind: 'idle' }
      return { kind: 'action', label: getURLFetchHeaderLabel(last.fetches) }
    case 'code_exec':
      if (!last.calls.some((c) => c.status === 'running'))
        return { kind: 'idle' }
      return { kind: 'action', label: getCodeExecHeaderLabel(last.calls) }
  }
}

function Chevron({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transform text-content-primary/40 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  )
}

export const WorkProcess = memo(function WorkProcess({
  blocks,
  isActive,
  isDarkMode,
}: WorkProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const activity = useMemo(
    () => (isActive ? getLiveActivity(blocks) : null),
    [blocks, isActive],
  )
  const activeThinking = activity?.kind === 'thinking' ? activity.block : null
  const summary = useThoughtSummary(
    activeThinking?.content ?? '',
    activeThinking !== null,
    true,
    activeThinking?.id,
  )

  const duration = useMemo(
    () => (isActive ? undefined : getWorkDurationSeconds(blocks)),
    [blocks, isActive],
  )

  const stepsNoun = `${blocks.length} step${blocks.length === 1 ? '' : 's'}`

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
        className="hover:bg-surface-secondary/50 group -mx-1 flex min-w-0 max-w-full cursor-pointer items-start gap-1.5 rounded-md px-1 py-1 text-left transition-colors"
      >
        <span className="mt-[5px] h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {activity?.kind === 'action' ? (
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin text-content-primary/50"
              aria-hidden="true"
              focusable="false"
            />
          ) : (
            <Chevron isExpanded={isExpanded} />
          )}
        </span>
        <span className="min-w-0 text-base text-content-primary/50">
          {activity?.kind === 'thinking' ? (
            summary ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="block animate-shimmer truncate bg-clip-text font-medium text-transparent motion-reduce:animate-none"
                  style={{
                    backgroundImage: isDarkMode
                      ? 'linear-gradient(90deg, #9ca3af 0%, #e5e7eb 25%, #f9fafb 50%, #e5e7eb 75%, #9ca3af 100%)'
                      : 'linear-gradient(90deg, #4b5563 0%, #6b7280 25%, #9ca3af 50%, #6b7280 75%, #4b5563 100%)',
                    backgroundSize: '200% 100%',
                  }}
                >
                  {summary}
                </span>
                <LoadingDots size="small" />
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="font-medium">Thinking</span>
                <LoadingDots size="small" />
              </span>
            )
          ) : activity?.kind === 'action' ? (
            <span className="font-medium">{activity.label}</span>
          ) : activity?.kind === 'idle' ? (
            <span className="flex items-center gap-1.5">
              <span className="font-medium">Working</span>
              <LoadingDots size="small" />
            </span>
          ) : (
            <span>
              <span className="font-medium">Worked</span>
              <span className="font-normal">
                {duration !== undefined
                  ? ` for ${formatDurationLabel(duration)}`
                  : ` through ${stepsNoun}`}
              </span>
            </span>
          )}
        </span>
      </button>

      <div
        inert={!isExpanded}
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-2 flex flex-col border-l-2 border-border-subtle py-1 pl-3 pr-1">
            {blocks.map((block) => {
              switch (block.type) {
                case 'thinking':
                  return (
                    <ThoughtProcess
                      key={block.id}
                      thoughts={block.content}
                      isDarkMode={isDarkMode}
                      isThinking={block.isThinking}
                      thinkingDuration={block.duration}
                      summary={block === activeThinking ? summary : ''}
                    />
                  )
                case 'web_search':
                  return (
                    <WebSearchProcess key={block.id} webSearch={block.state} />
                  )
                case 'url_fetches':
                  return (
                    <URLFetchProcess
                      key={block.id}
                      urlFetches={block.fetches}
                    />
                  )
                case 'code_exec':
                  return <CodeExecProcess key={block.id} calls={block.calls} />
              }
            })}
          </div>
        </div>
      </div>
    </div>
  )
})
