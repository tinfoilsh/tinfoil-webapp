#!/usr/bin/env node
/**
 * Serves the static production build (out/) with API proxying.
 *
 * Proxies:
 *   /api/local-router/* → http://localhost:8090/*
 *   /api/dev/simulator  → http://localhost:3001/api/dev/simulator
 *
 * Everything else is served from the out/ directory as static files.
 *
 * Usage:
 *   node scripts/dev-serve.mjs
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 3000
const ROUTER_UPSTREAM = 'http://localhost:8090'
const SIMULATOR_UPSTREAM = 'http://localhost:3001'
const MAX_LOG_BODY_BYTES = 10 * 1024 * 1024 // 10 MB
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out')
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs')

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.map': 'application/json',
}

function proxyRequest(req, res, upstream) {
  const url = new URL(upstream)
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res, { end: true })
  })

  proxyReq.on('error', (err) => {
    console.error(`Proxy error → ${upstream}: ${err.message}`)
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad Gateway')
  })

  req.pipe(proxyReq, { end: true })
}

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://localhost').pathname

  // Default to index.html for directory paths
  if (urlPath.endsWith('/')) urlPath += 'index.html'

  // Try the exact path, then with .html extension
  let filePath = path.resolve(OUT_DIR, '.' + urlPath)

  // Prevent path traversal outside OUT_DIR
  if (!filePath.startsWith(path.resolve(OUT_DIR))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  if (!fs.existsSync(filePath)) {
    // Try adding .html (Next.js static export convention)
    const withHtml = filePath + '.html'
    if (fs.existsSync(withHtml)) {
      filePath = withHtml
    } else {
      // SPA fallback: serve the chat page for unmatched routes
      const fallback = path.join(OUT_DIR, 'chat.html')
      if (fs.existsSync(fallback)) {
        filePath = fallback
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }
    }
  }

  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  const stream = fs.createReadStream(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  stream.pipe(res)
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500)
    }
    res.end()
  })
}

const server = http.createServer((req, res) => {
  // Proxy /api/local-router/* → model router (strip the prefix)
  if (req.url.startsWith('/api/local-router/')) {
    req.url = req.url.replace('/api/local-router', '')
    proxyRequest(req, res, ROUTER_UPSTREAM)
    return
  }

  // Proxy /api/dev/simulator → dev simulator
  if (req.url.startsWith('/api/dev/simulator')) {
    proxyRequest(req, res, SIMULATOR_UPSTREAM)
    return
  }

  // Dev stream logger: writes a chronological per-chat transcript to logs/.
  // Consecutive same-kind tokens are merged; tinfoil markers surface inline.
  if (req.url === '/api/dev/stream-log' && req.method === 'POST') {
    let body = ''
    let bodySize = 0
    req.on('data', (chunk) => {
      bodySize += chunk.length
      if (bodySize > MAX_LOG_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload too large' }))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (bodySize > MAX_LOG_BODY_BYTES) return
      try {
        const { chatId, events } = JSON.parse(body)
        if (!events || !Array.isArray(events)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing events array' }))
          return
        }

        const segments = []
        let cur = null
        const flush = () => {
          if (cur && cur.text) segments.push(cur)
          cur = null
        }
        const append = (kind, label, text) => {
          if (!text) return
          if (!cur || cur.kind !== kind || cur.label !== label) {
            flush()
            cur = { kind, label, text: '' }
          }
          cur.text += text
        }

        const TINFOIL_RE = /<tinfoil-event>([\s\S]*?)<\/tinfoil-event>/g
        // Returns alternating { kind: 'text'|'marker', value } pieces in order.
        const splitContent = (raw) => {
          const out = []
          let last = 0
          for (const m of raw.matchAll(TINFOIL_RE)) {
            if (m.index > last)
              out.push({ kind: 'text', value: raw.slice(last, m.index) })
            try {
              out.push({ kind: 'marker', value: JSON.parse(m[1]) })
            } catch {
              out.push({ kind: 'text', value: m[0] })
            }
            last = m.index + m[0].length
          }
          if (last < raw.length)
            out.push({ kind: 'text', value: raw.slice(last) })
          return out
        }

        let chunkCount = 0
        for (const entry of events) {
          if (entry?.type === 'tinfoil_event') {
            // Already captured in-position via splitContent above.
            continue
          }
          if (entry?.type !== 'parsed') continue
          chunkCount++
          const delta = entry.data?.choices?.[0]?.delta
          if (!delta) continue

          const reasoning =
            (typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : '') ||
            (typeof delta.reasoning === 'string' ? delta.reasoning : '')
          if (reasoning) append('reasoning', '', reasoning)

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc?.index ?? 0
              const name = tc?.function?.name || ''
              const args = tc?.function?.arguments
              const label = name ? `${name}#${idx}` : `#${idx}`
              if (typeof args === 'string') append('tool_args', label, args)
            }
          }

          if (typeof delta.content === 'string' && delta.content) {
            for (const piece of splitContent(delta.content)) {
              if (piece.kind === 'text') {
                append('content', '', piece.value)
                continue
              }
              const ev = piece.value
              const toolName = ev?.tool?.name || 'unknown'
              const status = ev?.status || ''
              flush()
              if (status === 'in_progress') {
                const args = ev?.tool?.arguments
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
                    typeof ev?.tool?.output === 'string' ? ev.tool.output : '',
                })
              }
            }
          }
        }
        flush()

        fs.mkdirSync(LOGS_DIR, { recursive: true })
        // One file per chat, appended turn-by-turn.
        const safeId = chatId ? String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_') : 'unknown'
        const filename = `chat-${safeId}.md`
        const filepath = path.join(LOGS_DIR, filename)
        const isNew = !fs.existsSync(filepath)

        let out = ''
        if (isNew) out += `# Chat ${chatId || 'unknown'}\n\n`
        const timestamp = new Date().toISOString()
        out += `\n## Turn @ ${timestamp} (${chunkCount} chunks)\n\n`
        for (const seg of segments) {
          const header =
            seg.kind === 'reasoning'
              ? '--- reasoning ---'
              : seg.kind === 'tool_args'
                ? `--- tool call args: ${seg.label} ---`
                : seg.kind === 'tool_call'
                  ? `--- tool call: ${seg.label} ---`
                  : seg.kind === 'tool_result'
                    ? `--- tool result: ${seg.label} ---`
                    : '--- content ---'
          out += `${header}\n${seg.text}\n\n`
        }

        fs.appendFileSync(filepath, out, 'utf-8')
        console.log(`  Stream log: ${filename} (+${chunkCount} chunks)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ file: filename, chunks: chunkCount }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // Everything else: static files
  serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`)
  console.log(`  Static files: ${OUT_DIR}`)
  console.log(`  Proxy: /api/local-router/* → ${ROUTER_UPSTREAM}`)
  console.log(`  Proxy: /api/dev/simulator  → ${SIMULATOR_UPSTREAM}`)
})
