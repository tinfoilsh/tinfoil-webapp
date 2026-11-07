import type {
  TimelineBlock,
  TimelineToolCallBlock,
} from '@/components/chat/types'
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

function hasDrawableArguments(block: TimelineToolCallBlock): boolean {
  if (block.invalidArguments) return false
  try {
    JSON.parse(block.arguments)
    return true
  } catch {
    return false
  }
}

/**
 * Leaves out widget calls the harness refused once the reply goes on to draw
 * the same widget. The harness asks the model to call a widget again when it
 * refuses its arguments, so a later call is the retry and the refused one has
 * nothing left to show or offer.
 */
export function withoutRetriedWidgetCalls(
  timeline: TimelineBlock[],
): TimelineBlock[] {
  const refused = new Set(
    timeline.flatMap((block) =>
      block.type === 'tool_call' && block.invalidArguments ? [block.name] : [],
    ),
  )
  if (refused.size === 0) return timeline
  const drawnLater = new Set<string>()
  const shown: TimelineBlock[] = []
  for (const block of [...timeline].reverse()) {
    if (block.type === 'tool_call' && refused.has(block.name)) {
      if (block.invalidArguments && drawnLater.has(block.name)) continue
      if (hasDrawableArguments(block)) drawnLater.add(block.name)
    }
    shown.push(block)
  }
  return shown.length === timeline.length ? timeline : shown.reverse()
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
