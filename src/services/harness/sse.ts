import type { Frame, HarnessErrorBody, HarnessEvent } from './types'

export class HarnessError extends Error {
  get code() {
    return this.detail.code
  }
  constructor(
    public readonly detail: HarnessErrorBody,
    public readonly status?: number,
  ) {
    super(detail.message)
    this.name = 'HarnessError'
  }
}

const maxFrameCharacters = 8 * 1024 * 1024

// SSE fields are parsed after UTF-8 decoding, so split multibyte characters,
// CRLF boundaries, comments, and multiline data survive arbitrary chunking.
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let size = 0
  let id: number | undefined
  let terminal = false
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      while (buffer.length) {
        const boundary = buffer.search(/[\r\n]/)
        if (
          boundary < 0 ||
          (buffer[boundary] === '\r' &&
            boundary === buffer.length - 1 &&
            !chunk.done)
        )
          break
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(
          boundary +
            (buffer[boundary] === '\r' && buffer[boundary + 1] === '\n'
              ? 2
              : 1),
        )
        if (line === '') {
          if (data.length) {
            let event: HarnessEvent
            try {
              event = JSON.parse(data.join('\n')) as HarnessEvent
              if (
                !event ||
                typeof event !== 'object' ||
                typeof event.type !== 'string'
              )
                throw new Error()
            } catch {
              throw new HarnessError({
                code: 'INVALID_STREAM',
                message: 'The chat stream contained an invalid event.',
              })
            }
            terminal ||=
              event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
            yield { event, id }
          }
          data = []
          id = undefined
          size = 0
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'data') {
            data.push(value)
            size += value.length
          } else if (field === 'id') {
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
              throw new HarnessError({
                code: 'INVALID_STREAM',
                message: 'The chat stream contained an invalid cursor.',
              })
            }
            id = Number(value)
          }
        }
        if (size > maxFrameCharacters)
          throw new HarnessError({
            code: 'INVALID_STREAM',
            message: 'The chat event exceeded its size limit.',
          })
      }
      if (size + buffer.length > maxFrameCharacters)
        throw new HarnessError({
          code: 'INVALID_STREAM',
          message: 'The chat event exceeded its size limit.',
        })
      if (chunk.done) break
    }
    if (!terminal)
      throw new HarnessError({
        code: 'STREAM_INTERRUPTED',
        message: 'The connection closed. Reconnect to continue this run.',
      })
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
