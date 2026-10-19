import type { ChatChunkStream } from '@/services/inference/chat-stream'
import type { Message } from '../../types'
import { RichStreamSession } from './rich-stream-session'

export interface RichResponseParserOptions {
  trackThinkingDuration?: boolean
  onUpdate?: (message: Message) => void
  onFirstEvent?: () => void
  onThinkingChange?: (isThinking: boolean) => void
  modelDisplayName?: string
  resolveModelDisplayName?: (modelName: string) => string | undefined
}

export async function parseRichStreamingResponse(
  stream: ChatChunkStream,
  options: RichResponseParserOptions = {},
): Promise<Message> {
  const session = new RichStreamSession(options)

  try {
    for await (const chunk of stream) {
      if (session.processChunk(chunk)) options.onUpdate?.(session.snapshot())
    }
    const message = session.complete()
    options.onUpdate?.(message)
    return message
  } finally {
    session.close()
  }
}
