import type {
  Attachment,
  Chat,
  Message,
  TimelineBlock,
} from '@/components/chat/types'
import type {
  ThreadSummary,
  AttachmentDescriptor as WireAttachment,
  TimelineBlock as WireBlock,
  Message as WireMessage,
} from './types'

const SEARCH_STATUS = {
  running: 'searching',
  completed: 'completed',
  failed: 'failed',
} as const
const FETCH_STATUS = {
  running: 'fetching',
  completed: 'completed',
  failed: 'failed',
} as const

// A web search or page fetch shows what the harness reports of it. A call
// it reports nothing of yet runs while its reply streams; one still running
// once the reply stopped was cut off.
function toolBlock(block: WireBlock, streaming: boolean): TimelineBlock {
  const toolCallId = block.toolCallId ?? block.id
  const { display } = block
  const status = streaming
    ? (display?.status ?? 'running')
    : display?.status === 'completed'
      ? 'completed'
      : 'failed'
  if (block.name === 'web_search')
    return {
      type: 'web_search',
      id: block.id,
      state: {
        query: display?.query,
        status: SEARCH_STATUS[status],
        sources: display?.sources ?? [],
      },
    }
  if (block.name === 'web_fetch')
    return {
      type: 'url_fetches',
      id: block.id,
      fetches: [
        {
          id: toolCallId,
          url: display?.url ?? '',
          status: FETCH_STATUS[status],
          sources: display?.sources,
        },
      ],
    }
  return {
    ...block,
    type: 'tool_call',
    toolCallId,
    name: block.name ?? '',
    arguments: block.arguments ?? '',
  }
}

export function attachmentView(
  a: Pick<
    WireAttachment,
    | 'id'
    | 'kind'
    | 'fileName'
    | 'mimeType'
    | 'size'
    | 'textContent'
    | 'thumbnail'
  >,
): Attachment {
  return {
    id: a.id,
    type: a.kind === 'image' ? 'image' : 'document',
    fileName: a.fileName,
    mimeType: a.mimeType,
    fileSize: a.size,
    textContent: a.textContent,
    thumbnailBase64: a.thumbnail ?? undefined,
  }
}
// A message as the view shows it, with the latest summary of each thinking
// block's reasoning.
export function messageView(
  message: WireMessage,
  streaming = false,
  summaries: Readonly<Record<string, string>> = {},
): Message {
  const blocks = message.timeline ?? []
  const timeline: TimelineBlock[] = blocks.map((block, index) => {
    // A reply thinks only in its last block: reasoning ends once the reply
    // goes on to text or a tool call.
    if (block.type === 'thinking')
      return {
        ...block,
        type: 'thinking',
        content: block.content ?? '',
        isThinking: streaming && index === blocks.length - 1 && !block.complete,
        ...(summaries[block.id] ? { summary: summaries[block.id] } : {}),
      }
    if (block.type === 'content')
      return { ...block, type: 'content', content: block.content ?? '' }
    return toolBlock(block, streaming)
  })
  return {
    id: message.id,
    role: message.role,
    timestamp: new Date(message.createdAt),
    content:
      message.content ??
      timeline
        .filter((b) => b.type === 'content')
        .map((b) => b.content)
        .join(''),
    timeline,
    quote: message.quote,
    modelDisplayName: message.modelDisplayName,
    attachments: message.attachments?.map(attachmentView),
    annotations: message.annotations,
    isError: message.isError,
    isInterrupted: message.isInterrupted,
  }
}
export function threadView(
  thread: ThreadSummary,
  messages: Message[] = [],
): Chat {
  return {
    id: thread.id,
    title: thread.title,
    titleState: thread.titleState,
    createdAt: new Date(thread.createdAt),
    updatedAt: thread.updatedAt,
    model: thread.model,
    projectId: thread.projectId ?? undefined,
    webSearchEnabled: thread.webSearchEnabled,
    messageCount: thread.messageCount,
    messages,
    isMetadataOnly: messages.length === 0,
    pinned: thread.pinned,
    activeRun: thread.activeRun,
    ...(thread.flagged ? { flagged: true } : {}),
  }
}
