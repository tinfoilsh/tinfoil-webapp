import type {
  Attachment,
  Chat,
  Message,
  TimelineBlock,
} from '@/components/chat/types'
import type {
  ThreadSummary,
  Attachment as WireAttachment,
  Message as WireMessage,
} from './types'

export function attachmentView(a: WireAttachment): Attachment {
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
export function messageView(message: WireMessage, streaming = false): Message {
  const blocks: TimelineBlock[] = (message.timeline ?? []).map((block) => {
    if (block.type === 'thinking')
      return {
        ...block,
        type: 'thinking',
        content: block.content ?? '',
        isThinking: streaming && !block.complete,
      }
    if (block.type === 'content')
      return { ...block, type: 'content', content: block.content ?? '' }
    return {
      ...block,
      type: 'tool_call',
      toolCallId: block.toolCallId ?? block.id,
      name: block.name ?? '',
      arguments: block.arguments ?? '',
      resolvedAt:
        block.resolvedAt == null
          ? undefined
          : new Date(block.resolvedAt).getTime(),
      resolution: block.resolution ?? undefined,
    }
  })
  const timeline: TimelineBlock[] = []
  let thinking: Extract<TimelineBlock, { type: 'thinking' }> | undefined
  for (const block of blocks) {
    if (block.type === 'thinking') {
      if (thinking) {
        thinking.content += block.content
        thinking.isThinking ||= block.isThinking
      } else {
        thinking = block
        timeline.unshift(thinking)
      }
    } else {
      const previous = timeline.at(-1)
      if (block.type === 'content' && previous?.type === 'content')
        previous.content += block.content
      else timeline.push(block)
    }
  }
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
  }
}
