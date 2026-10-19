import type {
  Annotation,
  TimelineBlock,
  URLFetchState,
  WebSearchState,
} from '@/components/chat/types'
import { logWarning } from '@/utils/error-handling'

/**
 * Shareable chat data structure for URL encoding
 */
export type ShareableAttachment = {
  id: string
  type: 'image' | 'document'
  fileName: string
  mimeType?: string
  thumbnailBase64?: string
  encryptionKey?: string
  textContent?: string
  description?: string
}

export type ShareableChatData = {
  v: 1
  title: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    modelDisplayName?: string
    documentContent?: string
    documents?: Array<{ name: string }>
    timestamp: number
    thoughts?: string
    thinkingDuration?: number
    isError?: boolean
    attachments?: ShareableAttachment[]
    // Timeline is the source of truth for assistant messages; preserving it
    // keeps web searches, URL fetches, tool widgets, and code execution
    // results visible in shared views. Optional for back-compat with shares
    // created before the timeline was included.
    timeline?: TimelineBlock[]
    annotations?: Annotation[]
    webSearch?: WebSearchState
    webSearchBeforeThinking?: boolean
    urlFetches?: URLFetchState[]
  }>
  createdAt: number
}

/**
 * Validate shareable chat data structure
 * Returns null if data is invalid
 */
export function validateShareableChatData(
  data: unknown,
): ShareableChatData | null {
  if (
    typeof data !== 'object' ||
    data === null ||
    (data as Record<string, unknown>).v !== 1 ||
    typeof (data as Record<string, unknown>).title !== 'string' ||
    !Array.isArray((data as Record<string, unknown>).messages) ||
    typeof (data as Record<string, unknown>).createdAt !== 'number'
  ) {
    logWarning('Invalid shareable chat data structure', {
      component: 'CompressionUtil',
      action: 'validateShareableChatData',
    })
    return null
  }

  const typedData = data as Record<string, unknown>
  for (const msg of typedData.messages as unknown[]) {
    if (
      typeof msg !== 'object' ||
      msg === null ||
      ((msg as Record<string, unknown>).role !== 'user' &&
        (msg as Record<string, unknown>).role !== 'assistant') ||
      typeof (msg as Record<string, unknown>).content !== 'string' ||
      typeof (msg as Record<string, unknown>).timestamp !== 'number' ||
      ('modelDisplayName' in msg &&
        typeof (msg as Record<string, unknown>).modelDisplayName !== 'string')
    ) {
      logWarning('Invalid message in shareable chat data', {
        component: 'CompressionUtil',
        action: 'validateShareableChatData',
      })
      return null
    }
  }

  return data as ShareableChatData
}
