import type {
  Message,
  TimelineBlock,
  ToolCallState,
  URLFetchState,
  WebSearchState,
} from '../../types'

function finalizeWebSearchState(state: WebSearchState): WebSearchState {
  return state.status === 'searching' ? { ...state, status: 'failed' } : state
}

function finalizeURLFetchState(state: URLFetchState): URLFetchState {
  return state.status === 'fetching' ? { ...state, status: 'failed' } : state
}

function finalizeToolCallState(state: ToolCallState): ToolCallState {
  return state.status === 'running' ? { ...state, status: 'failed' } : state
}

function finalizeTimelineBlock(block: TimelineBlock): TimelineBlock {
  switch (block.type) {
    case 'thinking':
      return block.isThinking ? { ...block, isThinking: false } : block
    case 'web_search':
      return { ...block, state: finalizeWebSearchState(block.state) }
    case 'url_fetches':
      return {
        ...block,
        fetches: block.fetches.map(finalizeURLFetchState),
      }
    case 'code_exec':
      return {
        ...block,
        calls: block.calls.map(finalizeToolCallState),
      }
    default:
      return block
  }
}

export function hasVisibleAssistantMessage(message: Message): boolean {
  return Boolean(
    message.content ||
    message.thoughts ||
    message.webSearch ||
    message.urlFetches?.length ||
    message.annotations?.length ||
    message.searchReasoning ||
    message.toolCalls?.length ||
    message.codeExecCalls?.length,
  )
}

export function finalizeInterruptedMessage(
  message: Message,
  turnId?: string,
): Message {
  return {
    ...message,
    turnId: turnId ?? message.turnId,
    isThinking: false,
    webSearch: message.webSearch
      ? finalizeWebSearchState(message.webSearch)
      : undefined,
    urlFetches: message.urlFetches?.map(finalizeURLFetchState),
    codeExecCalls: message.codeExecCalls?.map(finalizeToolCallState),
    timeline: message.timeline?.map(finalizeTimelineBlock),
  }
}

export function mergeInterruptedAssistant(
  messages: Message[],
  turnId: string,
  assistantMessage: Message | null,
): Message[] {
  const assistantIndex = messages.findIndex(
    (message) => message.role === 'assistant' && message.turnId === turnId,
  )
  if (!assistantMessage) {
    return assistantIndex < 0
      ? messages
      : messages.filter((_, index) => index !== assistantIndex)
  }

  const finalizedMessage = finalizeInterruptedMessage(assistantMessage, turnId)
  if (assistantIndex >= 0) {
    const merged = [...messages]
    merged[assistantIndex] = finalizedMessage
    return merged
  }

  const userIndex = messages.findIndex(
    (message) => message.role === 'user' && message.turnId === turnId,
  )
  const insertAt = userIndex >= 0 ? userIndex + 1 : messages.length
  return [
    ...messages.slice(0, insertAt),
    finalizedMessage,
    ...messages.slice(insertAt),
  ]
}
