import { ERROR_ACTIONS, ERROR_CODES } from './protocol'
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

// SSE fields are parsed after UTF-8 decoding, so split multibyte characters,
// CRLF boundaries, comments, and multiline data survive arbitrary chunking.
// Each chunk's text is searched for line breaks once, so an event of any size
// is read in time proportional to it.
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const lineBreak = /[\r\n]/g
  // The line read so far, and whether the text before ended in a CR, whose
  // LF may start the next text.
  let partial = ''
  let afterCR = false
  let data: string[] = []
  let id: number | undefined
  let terminal = false
  try {
    while (true) {
      const chunk = await reader.read()
      let text = decoder.decode(chunk.value, { stream: !chunk.done })
      if (afterCR && text) {
        if (text[0] === '\n') text = text.slice(1)
        afterCR = false
      }
      let start = 0
      lineBreak.lastIndex = 0
      for (
        let found = lineBreak.exec(text);
        found;
        found = lineBreak.exec(text)
      ) {
        const line = partial + text.slice(start, found.index)
        partial = ''
        start = found.index + 1
        if (text[found.index] === '\r') {
          if (text[start] === '\n') start++
          else afterCR = start === text.length
        }
        lineBreak.lastIndex = start
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
                code: ERROR_CODES.invalidStream,
                action: ERROR_ACTIONS.stop,
                message: 'The chat stream contained an invalid event.',
              })
            }
            terminal ||=
              event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
            yield { event, id }
          }
          data = []
          id = undefined
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'data') {
            data.push(value)
          } else if (field === 'id') {
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
              throw new HarnessError({
                code: ERROR_CODES.invalidStream,
                action: ERROR_ACTIONS.stop,
                message: 'The chat stream contained an invalid cursor.',
              })
            }
            id = Number(value)
          }
        }
      }
      partial += text.slice(start)
      if (chunk.done) break
    }
    if (!terminal)
      throw new HarnessError({
        code: ERROR_CODES.streamInterrupted,
        action: ERROR_ACTIONS.retry,
        message: 'The connection closed. Reconnect to continue this run.',
      })
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
