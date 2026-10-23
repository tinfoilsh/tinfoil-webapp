import type {
  Attachment,
  Chat,
  Message,
  TimelineBlock,
} from '@/components/chat/types'
import { DEFAULT_CHAT_TITLE, PLACEHOLDER_CHAT_TITLE } from '@/constants/chat'
import { WIDGET_PREFIX } from './protocol'
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

const isShownTool = (name = '') =>
  name === 'web_search' ||
  name === 'web_fetch' ||
  name.startsWith(WIDGET_PREFIX)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parsed(text = ''): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// The pages a fetch reads, as its arguments name them; while they stream,
// the page the harness reports.
function fetchedUrls(block: WireBlock): string[] {
  const args = parsed(block.arguments)
  const urls = (isRecord(args) ? [args.urls, args.url].flat() : []).filter(
    (url): url is string => typeof url === 'string' && url !== '',
  )
  return urls.length ? urls : [block.display?.url ?? '']
}

// The pages a fetch's result lists as not read.
function unreadUrls(result: unknown): Set<string> {
  const failed =
    isRecord(result) && Array.isArray(result.failed) ? result.failed : []
  return new Set(
    failed.flatMap((page) =>
      isRecord(page) && typeof page.url === 'string' ? [page.url] : [],
    ),
  )
}

// The least or greatest of the times known.
function bound(
  pick: (...values: number[]) => number,
  ...values: (number | undefined)[]
): number | undefined {
  const known = values.filter((value) => value !== undefined)
  return known.length ? pick(...known) : undefined
}

// Back-to-back page reads show as one step, from the first read's start to
// the last one's end.
function mergedReads(timeline: TimelineBlock[]): TimelineBlock[] {
  const merged: TimelineBlock[] = []
  for (const block of timeline) {
    const last = merged.at(-1)
    if (block.type !== 'url_fetches' || last?.type !== 'url_fetches') {
      merged.push(block)
      continue
    }
    merged[merged.length - 1] = {
      ...last,
      fetches: [...last.fetches, ...block.fetches],
      startedAt: bound(Math.min, last.startedAt, block.startedAt),
      // A read that never ended counts until it started, as it does alone.
      endedAt: bound(
        Math.max,
        last.endedAt ?? last.startedAt,
        block.endedAt ?? block.startedAt,
      ),
    }
  }
  return merged
}

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
  const timing = { startedAt: block.startedAt, endedAt: block.endedAt }
  if (block.name === 'web_search')
    return {
      type: 'web_search',
      id: block.id,
      state: {
        query: display?.query,
        status: SEARCH_STATUS[status],
        sources: display?.sources ?? [],
      },
      ...timing,
    }
  if (block.name === 'web_fetch') {
    const unread = unreadUrls(block.result)
    return {
      type: 'url_fetches',
      id: block.id,
      ...timing,
      fetches: fetchedUrls(block).map((url, index) => ({
        id: index ? `${toolCallId}-${index}` : toolCallId,
        url,
        status:
          status === 'completed' && unread.has(url)
            ? 'failed'
            : FETCH_STATUS[status],
        sources: display?.sources.filter((source) => source.url === url),
      })),
    }
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
  const views = blocks.flatMap<TimelineBlock>((block, index) => {
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
    // A tool that is neither a search nor a widget, as the code an older
    // chat ran, has no view.
    if (!isShownTool(block.name)) return []
    return toolBlock(block, streaming)
  })
  const timeline = mergedReads(views)
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
// A chat waiting for its generated title shows the default one.
export const chatTitle = ({
  title,
  titleState,
}: Pick<ThreadSummary, 'title' | 'titleState'>) =>
  titleState === 'placeholder' && title === PLACEHOLDER_CHAT_TITLE
    ? DEFAULT_CHAT_TITLE
    : title
export function threadView(
  thread: ThreadSummary,
  messages: Message[] = [],
): Chat {
  return {
    id: thread.id,
    title: chatTitle(thread),
    titleState: thread.titleState,
    createdAt: new Date(thread.createdAt),
    updatedAt: thread.updatedAt,
    activityAt: thread.activityAt ?? thread.createdAt,
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
