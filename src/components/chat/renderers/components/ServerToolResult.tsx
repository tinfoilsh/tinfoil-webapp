import type { TimelineToolCallBlock } from '../../types'
import { CodeExecProcess } from './CodeExecProcess'
import { URLFetchProcess } from './URLFetchProcess'
import { WebSearchProcess } from './WebSearchProcess'
export function ServerToolResult({
  block,
  isStreaming,
}: {
  block: TimelineToolCallBlock
  isStreaming: boolean
}) {
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
    return (
      <WebSearchProcess
        webSearch={{
          query: result.query ?? args.query,
          status: running ? 'searching' : failed ? 'failed' : 'completed',
          sources: result.results ?? [],
        }}
      />
    )
  if (block.name === 'web_fetch')
    return (
      <URLFetchProcess
        urlFetches={[
          {
            id: block.toolCallId,
            url: result.url ?? args.url ?? '',
            status: running ? 'fetching' : failed ? 'failed' : 'completed',
          },
        ]}
      />
    )
  return (
    <CodeExecProcess
      calls={[
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
      ]}
    />
  )
}
