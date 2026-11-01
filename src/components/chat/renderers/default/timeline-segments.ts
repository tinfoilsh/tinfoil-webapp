import type { TimelineBlock } from '@/components/chat/types'
import { isAnyURLFetching } from '../components/URLFetchProcess'
import type { WorkBlock } from '../components/WorkProcess'

export type TimelineSegment =
  | { kind: 'block'; block: TimelineBlock; blockIndex: number }
  | { kind: 'work'; key: string; blocks: WorkBlock[] }

function isWorkBlock(block: TimelineBlock): block is WorkBlock {
  return (
    block.type === 'thinking' ||
    block.type === 'web_search' ||
    block.type === 'url_fetches'
  )
}

/**
 * Blocks that render nothing (stray "\n\n" between tool calls, an empty
 * closed thinking block). They neither show up nor split a work run.
 */
export function isInvisibleBlock(block: TimelineBlock): boolean {
  switch (block.type) {
    case 'content':
      return !block.content.trim()
    case 'thinking':
      return !block.content.trim() && !block.isThinking
    case 'url_fetches':
      return block.fetches.length === 0
    default:
      return false
  }
}

// Whether a block is a step that still runs.
export function isRunningStep(block: TimelineBlock): boolean {
  switch (block.type) {
    case 'thinking':
      return block.isThinking
    case 'web_search':
      return block.state.status === 'searching'
    case 'url_fetches':
      return isAnyURLFetching(block.fetches)
    default:
      return false
  }
}

/**
 * Groups consecutive trace blocks (thinking, web search, URL fetches) into
 * a single "work" segment so the renderer can collapse them behind one row. Runs of a single block are left as plain blocks; answer
 * text and GenUI widgets end a run.
 */
export function segmentTimeline(timeline: TimelineBlock[]): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  let run: WorkBlock[] = []
  let runStartIndex = -1

  const flush = () => {
    if (run.length > 1) {
      segments.push({ kind: 'work', key: `work-${run[0].id}`, blocks: run })
    } else if (run.length === 1) {
      segments.push({
        kind: 'block',
        block: run[0],
        blockIndex: runStartIndex,
      })
    }
    run = []
  }

  timeline.forEach((block, blockIndex) => {
    if (isInvisibleBlock(block)) return
    if (isWorkBlock(block)) {
      if (run.length === 0) runStartIndex = blockIndex
      run.push(block)
      return
    }
    flush()
    segments.push({ kind: 'block', block, blockIndex })
  })
  flush()
  return segments
}
