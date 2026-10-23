// A port of the harness's legacy.go. Chats the previous client stored on the
// device use older timeline blocks and inline attachment fields; the harness
// upgrades them the same way when they arrive as a local transcript, so the
// browser can show a stored chat exactly as the harness will read it.

type Value = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const obj = (value: unknown): Value =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : {}
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const boolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback
const firstString = (...values: unknown[]): string =>
  values.map(str).find((value) => value !== '') ?? ''

const MAX_SHOWN_OUTPUT = 1 << 20

// Go's encoding/json escapes these characters, so tool arguments match the
// strings the harness would produce for the same blocks.
function goJSON(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MAX_DATE_MILLISECONDS = 8.64e15

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return month === 2 && leap ? 29 : MONTH_DAYS[month - 1]
}

function formatUTC(milliseconds: number, fraction: string): string {
  const seconds = new Date(milliseconds).toISOString().slice(0, 19)
  const digits = fraction.replace(/0+$/, '')
  return `${seconds}${digits ? `.${digits}` : ''}Z`
}

// isoTime mirrors time.Parse(time.RFC3339Nano) followed by a UTC
// RFC3339Nano format, which drops trailing fractional zeros. Text that does
// not parse is kept as it is.
export function isoTime(value: unknown): string {
  const text =
    value instanceof Date
      ? Number.isNaN(value.getTime())
        ? ''
        : value.toISOString()
      : str(value)
  if (text) {
    const match = RFC3339.exec(text)
    if (!match) return text
    const [year, month, day, hour, minute, second] = match
      .slice(1, 7)
      .map(Number)
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month) ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return text
    let offset = 0
    if (match[8] !== 'Z') {
      const offsetHours = Number(match[10])
      const offsetMinutes = Number(match[11])
      if (offsetHours > 24 || offsetMinutes > 60) return text
      offset = (offsetHours * 60 + offsetMinutes) * (match[9] === '-' ? -1 : 1)
    }
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, 0)
    return formatUTC(date.getTime() - offset * 60_000, match[7] ?? '')
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.trunc(value)
    if (milliseconds > 0 && milliseconds <= MAX_DATE_MILLISECONDS)
      return formatUTC(
        milliseconds,
        String(milliseconds % 1000).padStart(3, '0'),
      )
  }
  return ''
}

function pathBase(path: string): string {
  if (path === '') return '.'
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

// The part of the harness's normalizeToolResult that a stored code
// execution call can reach. The previous client recorded these tools.
function codeExecutionResult(name: string, args: string, output: string) {
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    result = { output }
  }
  const value = obj(result)
  if (name.startsWith('render_')) return result
  let budget = MAX_SHOWN_OUTPUT
  const take = (text: string) => {
    const shown =
      text.length > budget ? `${text.slice(0, budget)}\n[truncated]` : text
    budget -= Math.min(budget, shown.length)
    return shown
  }
  if (name === 'present') {
    if (Object.hasOwn(value, 'filename')) return value
    let parsedArgs: unknown = null
    try {
      parsedArgs = JSON.parse(args)
    } catch {
      parsedArgs = null
    }
    let language = ''
    let body = output
    const newline = output.indexOf('\n')
    if (newline >= 0) {
      const header = output.slice(0, newline)
      const rest = output.slice(newline + 1)
      const fence = header.slice(
        0,
        header.length - header.replace(/^`+/, '').length,
      )
      if (fence.length >= 3) {
        language = header.slice(fence.length)
        body = rest.endsWith(`\n${fence}`)
          ? rest.slice(0, rest.length - fence.length - 1)
          : rest
      }
    }
    return {
      filename: pathBase(str(obj(parsedArgs).path)),
      language,
      content: take(body),
    }
  }
  return { output: take(firstString(value.output, value.stdout) || output) }
}

// Read old timeline variants once. Flat legacy fields stay on the message.
export function upgradeTimeline(message: Value): void {
  if (message.role !== 'assistant') return
  let source = arr(message.timeline)
  const id = str(message.id)
  if (source.length === 0) {
    source = []
    const search = obj(message.webSearch)
    const addSearch = () => {
      if (Object.keys(search).length > 0)
        source.push({ type: 'web_search', id: `${id}-search`, state: search })
    }
    const searchFirst = boolean(message.webSearchBeforeThinking, false)
    if (searchFirst) addSearch()
    const thoughts = str(message.thoughts)
    if (thoughts)
      source.push({
        type: 'thinking',
        id: `${id}-thinking`,
        content: thoughts,
        duration: message.thinkingDuration ?? null,
      })
    if (!searchFirst) addSearch()
    const fetches = arr(message.urlFetches)
    if (fetches.length > 0)
      source.push({ type: 'url_fetches', id: `${id}-fetches`, fetches })
    const calls = arr(message.codeExecCalls)
    if (calls.length > 0)
      source.push({ type: 'code_exec', id: `${id}-code`, calls })
    for (const item of arr(message.toolCalls)) {
      const call = structuredClone(obj(item))
      call.type = 'tool_call'
      call.toolCallId = call.id ?? null
      source.push(call)
    }
    const content = str(message.content)
    if (content) source.push({ type: 'content', id: `${id}-content`, content })
  }
  const blocks: Value[] = []
  const call = (
    callId: string,
    name: string,
    args: string,
    result: unknown,
  ) => {
    blocks.push({
      type: 'tool_call',
      id: callId,
      toolCallId: callId,
      name,
      arguments: args,
      result,
      complete: true,
    })
  }
  source.forEach((item, index) => {
    const block = obj(item)
    const blockId = firstString(block.id, `${id}-block-${index}`)
    switch (block.type) {
      case 'web_search': {
        const state = obj(block.state)
        const results = arr(state.sources).map((value) => {
          const row = obj(value)
          return {
            url: row.url ?? null,
            title: row.title ?? null,
            snippet: firstString(row.snippet, row.description),
          }
        })
        call(blockId, 'web_search', goJSON({ query: str(state.query) }), {
          query: str(state.query),
          results,
        })
        break
      }
      case 'url_fetches':
        arr(block.fetches).forEach((value, fetchIndex) => {
          const fetch = obj(value)
          call(
            firstString(fetch.id, `${blockId}-${fetchIndex}`),
            'web_fetch',
            goJSON({ url: fetch.url ?? null }),
            {
              url: fetch.url ?? null,
              title: str(fetch.title),
              text: str(fetch.text),
            },
          )
        })
        break
      case 'code_exec':
        arr(block.calls).forEach((value, callIndex) => {
          const codeCall = obj(value)
          const args =
            str(codeCall.arguments) || goJSON(obj(codeCall.arguments))
          call(
            firstString(codeCall.id, `${blockId}-${callIndex}`),
            str(codeCall.toolName),
            args,
            codeExecutionResult(
              str(codeCall.toolName),
              args,
              str(codeCall.output),
            ),
          )
        })
        break
      default:
        block.id = blockId
        blocks.push(block)
    }
  })
  message.timeline = blocks
}

export function upgradeAttachments(message: Value): void {
  let attachments = arr(message.attachments)
  if (attachments.length === 0) {
    attachments = []
    const content = firstString(message.documentContent, message.multimodalText)
    if (content)
      attachments.push({
        type: 'document',
        fileName: 'Attached document',
        textContent: content,
      })
    arr(message.imageData).forEach((item, index) => {
      const image = obj(item)
      if (str(image.base64))
        attachments.push({
          type: 'image',
          fileName: `image-${index}`,
          mimeType: firstString(image.mimeType, 'image/png'),
          base64: image.base64,
        })
    })
  }
  attachments.forEach((item, index) => {
    const attachment = obj(item)
    if (!str(attachment.id))
      attachment.id = `${str(message.id)}-attachment-${index}`
  })
  if (attachments.length > 0) message.attachments = attachments
}

// The message loop of the harness's normalizeThread: a message without an id
// or creation time gets the one the harness would assign to it.
export function upgradeMessages(
  threadId: string,
  threadCreatedAt: unknown,
  messages: unknown[],
): Value[] {
  return messages.map((item, index) => {
    const message = structuredClone(obj(item))
    if (!str(message.id)) message.id = `${threadId}-message-${index}`
    if (!str(message.createdAt))
      message.createdAt = firstString(
        isoTime(message.timestamp),
        isoTime(threadCreatedAt),
      )
    upgradeTimeline(message)
    upgradeAttachments(message)
    return message
  })
}
