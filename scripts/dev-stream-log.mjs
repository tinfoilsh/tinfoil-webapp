import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BODY_BYTES = 10 * 1024 * 1024
const TINFOIL_EVENT_RE = /<tinfoil-event>([\s\S]*?)<\/tinfoil-event>/g

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function splitContent(raw) {
  const pieces = []
  let last = 0
  for (const match of raw.matchAll(TINFOIL_EVENT_RE)) {
    if (match.index > last) {
      pieces.push({ kind: 'text', value: raw.slice(last, match.index) })
    }
    try {
      pieces.push({ kind: 'marker', value: JSON.parse(match[1]) })
    } catch {
      pieces.push({ kind: 'text', value: match[0] })
    }
    last = match.index + match[0].length
  }
  if (last < raw.length) pieces.push({ kind: 'text', value: raw.slice(last) })
  return pieces
}

function renderSegments(events) {
  const segments = []
  let current = null
  let chunkCount = 0
  const flush = () => {
    if (current?.text) segments.push(current)
    current = null
  }
  const append = (kind, label, text) => {
    if (!text) return
    if (!current || current.kind !== kind || current.label !== label) {
      flush()
      current = { kind, label, text: '' }
    }
    current.text += text
  }

  for (const entry of events) {
    if (entry?.type === 'tinfoil_event') continue
    if (entry?.type !== 'parsed') continue
    chunkCount++
    const delta = entry.data?.choices?.[0]?.delta
    if (!delta) continue

    const reasoning =
      (typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : '') || (typeof delta.reasoning === 'string' ? delta.reasoning : '')
    if (reasoning) append('reasoning', '', reasoning)

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall?.index ?? 0
        const name = toolCall?.function?.name || ''
        const args = toolCall?.function?.arguments
        const label = name ? `${name}#${index}` : `#${index}`
        if (typeof args === 'string') append('tool_args', label, args)
      }
    }

    if (typeof delta.content !== 'string' || !delta.content) continue
    for (const piece of splitContent(delta.content)) {
      if (piece.kind === 'text') {
        append('content', '', piece.value)
        continue
      }
      const event = piece.value
      const toolName = event?.tool?.name || 'unknown'
      const status = event?.status || ''
      flush()
      if (status === 'in_progress') {
        const args = event?.tool?.arguments
        segments.push({
          kind: 'tool_call',
          label: `${toolName} (in_progress)`,
          text: args ? JSON.stringify(args, null, 2) : '',
        })
      } else {
        segments.push({
          kind: 'tool_result',
          label: `${toolName} (${status})`,
          text:
            typeof event?.tool?.output === 'string' ? event.tool.output : '',
        })
      }
    }
  }
  flush()
  return { segments, chunkCount }
}

function segmentHeader(segment) {
  if (segment.kind === 'reasoning') return '--- reasoning ---'
  if (segment.kind === 'tool_args') {
    return `--- tool call args: ${segment.label} ---`
  }
  if (segment.kind === 'tool_call') return `--- tool call: ${segment.label} ---`
  if (segment.kind === 'tool_result') {
    return `--- tool result: ${segment.label} ---`
  }
  return '--- content ---'
}

export function isDevStreamLogRequest(req) {
  return req.url === '/api/dev/stream-log' && req.method === 'POST'
}

export function handleDevStreamLog(req, res, { logsDir } = {}) {
  const outputDir = logsDir ?? path.join(process.cwd(), 'logs')
  let body = ''
  let bodySize = 0

  req.on('data', (chunk) => {
    bodySize += chunk.length
    if (bodySize > MAX_LOG_BODY_BYTES) {
      sendJson(res, 413, { error: 'Payload too large' })
      req.destroy()
      return
    }
    body += chunk
  })

  req.on('end', () => {
    if (bodySize > MAX_LOG_BODY_BYTES) return
    try {
      const { chatId, events } = JSON.parse(body)
      if (!Array.isArray(events)) {
        sendJson(res, 400, { error: 'Missing events array' })
        return
      }

      const { segments, chunkCount } = renderSegments(events)
      fs.mkdirSync(outputDir, { recursive: true })
      const safeId = chatId
        ? String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')
        : 'unknown'
      const filename = `chat-${safeId}.md`
      const filepath = path.join(outputDir, filename)
      let output = fs.existsSync(filepath)
        ? ''
        : `# Chat ${chatId || 'unknown'}\n\n`
      output += `\n## Turn @ ${new Date().toISOString()} (${chunkCount} chunks)\n\n`
      for (const segment of segments) {
        output += `${segmentHeader(segment)}\n${segment.text}\n\n`
      }
      fs.appendFileSync(filepath, output, 'utf-8')
      console.log(`  Stream log: ${filename} (+${chunkCount} chunks)`)
      sendJson(res, 200, { file: filename, chunks: chunkCount })
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })
}
