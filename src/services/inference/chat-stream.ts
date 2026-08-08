import { logError } from '@/utils/error-handling'

interface ChatChunkToolCall {
  index?: number
  id?: string
  function?: {
    name?: string | null
    arguments?: string
  }
}

interface ChatChunkDelta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  search_reasoning?: string | null
  annotations?: Array<{
    type?: string
    url_citation?: { title?: string; url?: string }
  }>
  tool_calls?: ChatChunkToolCall[]
  [key: string]: unknown
}

export interface ChatChunk {
  choices?: Array<{
    delta?: ChatChunkDelta
    message?: Pick<ChatChunkDelta, 'reasoning' | 'reasoning_content'>
    finish_reason?: string | null
    [key: string]: unknown
  }>
  id?: string
  model?: string
  status?: string
  action?: { query?: string }
  reason?: string
  type?: string
  [key: string]: unknown
}

export interface ChatChunkStream extends AsyncIterable<ChatChunk> {
  recoveryReady?: Promise<void>
  abandonRecovery?: () => Promise<void>
}

function isChatChunk(value: unknown): value is ChatChunk {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function* chatChunkStreamFromSSE(
  response: Response,
): AsyncGenerator<ChatChunk, void, undefined> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''
  let exhausted = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        exhausted = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue
        if (line === 'data: [DONE]') return

        try {
          const jsonData = line.replace(/^data:\s*/i, '')
          const chunk: unknown = JSON.parse(jsonData)
          if (!isChatChunk(chunk)) {
            throw new TypeError('SSE data must be a JSON object')
          }
          yield chunk
        } catch (error) {
          logError('Failed to parse SSE line', error, {
            component: 'chat-stream',
            metadata: { line },
          })
        }
      }
    }
  } finally {
    if (!exhausted) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
