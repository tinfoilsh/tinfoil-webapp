import type {
  TimelineBlock,
  TimelineCodeExecBlock,
  TimelineToolCallBlock,
  TimelineURLFetchBlock,
  TimelineWebSearchBlock,
} from '@/components/chat/types'
import { isGenUIToolName } from '../../genui/registry'

type ServerToolBlock =
  TimelineWebSearchBlock | TimelineURLFetchBlock | TimelineCodeExecBlock

function serverToolBlock(
  block: TimelineToolCallBlock,
  isStreaming: boolean,
): ServerToolBlock {
  let args: Record<string, any> = {}
  try {
    args = JSON.parse(block.arguments)
  } catch {
    /* arguments can still be streaming */
  }
  const result =
    block.result && typeof block.result === 'object'
      ? (block.result as Record<string, any>)
      : {}
  const failed = !!result.error
  const running = isStreaming && block.result === undefined
  if (block.name === 'web_search')
    return {
      type: 'web_search',
      id: block.id,
      state: {
        query: result.query ?? args.query,
        status: running ? 'searching' : failed ? 'failed' : 'completed',
        sources: result.results ?? [],
      },
    }
  if (block.name === 'web_fetch')
    return {
      type: 'url_fetches',
      id: block.id,
      fetches: [
        {
          id: block.toolCallId,
          url: result.url ?? args.url ?? '',
          status: running ? 'fetching' : failed ? 'failed' : 'completed',
        },
      ],
    }
  return {
    type: 'code_exec',
    id: block.id,
    calls: [
      {
        id: block.toolCallId,
        toolName: block.name,
        arguments: args,
        status: running ? 'running' : failed ? 'failed' : 'completed',
        output:
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(block.result ?? block.progress ?? ''),
      },
    ],
  }
}

/**
 * The chat service reports its own tools (web search, URL fetches, code
 * execution) as tool calls. Map them onto the trace blocks the renderer
 * groups into work rows; GenUI widget calls stay tool calls. The mapping is
 * one to one, so block indexes are preserved.
 */
export function toDisplayTimeline(
  timeline: TimelineBlock[],
  isStreaming: boolean,
): TimelineBlock[] {
  return timeline.map((block) =>
    block.type === 'tool_call' && !isGenUIToolName(block.name)
      ? serverToolBlock(block, isStreaming)
      : block,
  )
}
