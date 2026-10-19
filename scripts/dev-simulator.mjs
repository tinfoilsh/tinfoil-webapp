#!/usr/bin/env node
/**
 * Standalone development simulator server.
 *
 * This server provides a mock LLM endpoint for development and testing.
 * It simulates streaming responses with configurable thinking phases,
 * delays, and content patterns.
 *
 * Usage:
 *   node scripts/dev-simulator.mjs
 *   # or via npm script:
 *   npm run dev:simulator
 *
 * The server runs on port 3001 by default (configurable via DEV_SIMULATOR_PORT).
 */

import nextEnv from '@next/env'
import http from 'node:http'
import { parseProxyOrigin } from './dev-http-proxy.mjs'
import { handleDevStreamLog, isDevStreamLogRequest } from './dev-stream-log.mjs'
import { createLocalApiGateway } from './local-api-gateway.mjs'

nextEnv.loadEnvConfig(process.cwd(), true)

const PORT = process.env.DEV_SIMULATOR_PORT
  ? parseInt(process.env.DEV_SIMULATOR_PORT, 10)
  : 3001
const CONTROLPLANE_UPSTREAM = parseProxyOrigin(
  process.env.NEXT_PUBLIC_API_BASE_URL,
)

// ============================================================================
// Simulator patterns and streaming logic (copied from src/utils/dev-simulator.ts)
// ============================================================================

const SIMULATOR_PATTERNS = {
  'test thoughts': {
    thoughts: `Let me think about this request step by step...
    
First, I need to understand what you're asking for.
You want me to demonstrate the thinking process.

This is a longer thought process that will help test:
- How the UI handles thoughts appearing
- The transition from thinking to content
- Scrolling behavior during the transition
- Layout stability when content starts streaming

I should provide a detailed response after thinking...`,
    content: `Here's my response after thinking:

This is the actual content that appears after the thinking phase. It demonstrates how the interface handles the transition from thoughts to the main response.

The key points are:
1. Thoughts appear first with a thinking indicator
2. Content starts streaming after thoughts complete
3. The UI should scroll appropriately to keep content visible
4. No layout jumps should occur during transitions

This response includes multiple paragraphs to test scrolling behavior when longer content is generated after a thinking phase.`,
    thinkingDurationMs: 3000,
    streamDelayMs: 50,
    chunkSize: 5,
  },

  'test long thoughts': {
    thoughts: Array(50)
      .fill(0)
      .map(
        (_, i) =>
          `Thought ${i + 1}: Processing complex information and considering various factors...`,
      )
      .join('\n'),
    content: 'Brief response after extensive thinking.',
    thinkingDurationMs: 5000,
    streamDelayMs: 30,
    chunkSize: 10,
  },

  'test no thoughts': {
    content: `This is a direct response without any thinking phase.
    
It goes straight to generating content, which is the traditional behavior.
The streaming should work smoothly without any thinking indicator.`,
    streamDelayMs: 40,
    chunkSize: 8,
  },

  'test rapid': {
    thoughts: 'Quick thought...',
    content: 'Rapid response!',
    thinkingDurationMs: 500,
    streamDelayMs: 10,
    chunkSize: 20,
  },

  'test code': {
    thoughts: `Analyzing the code request...
Need to generate proper formatted code with syntax highlighting.`,
    content: `Here's a code example:

\`\`\`typescript
function testFunction() {
  // This tests code rendering after thoughts
  const result = 'Hello World';
  return result;
}
\`\`\`

The code block should render properly after the thinking phase.`,
    thinkingDurationMs: 2000,
    streamDelayMs: 30,
    chunkSize: 10,
  },
}

const DEFAULT_PATTERN = {
  thoughts: `Processing your request...
Analyzing the input to generate an appropriate response.`,
  content: `This is the default simulated response.

Your query: "{query}"

The simulator is working correctly and streaming this response with:
- Thinking phase duration: 2 seconds
- Streaming delay: 40ms between chunks
- Chunk size: 7 characters`,
  thinkingDurationMs: 2000,
  streamDelayMs: 40,
  chunkSize: 7,
}

function getSimulatorPattern(query) {
  const lowerQuery = query.toLowerCase()

  // Check for exact matches first
  for (const [key, pattern] of Object.entries(SIMULATOR_PATTERNS)) {
    if (lowerQuery === key) {
      return pattern
    }
  }

  // Check for partial matches
  for (const [key, pattern] of Object.entries(SIMULATOR_PATTERNS)) {
    if (lowerQuery.includes(key)) {
      return pattern
    }
  }

  // Return default with query interpolated
  return {
    ...DEFAULT_PATTERN,
    content: DEFAULT_PATTERN.content.replace('{query}', query),
  }
}

function chunkText(text, chunkSize) {
  const chunks = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

function escapeJson(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function delay(ms, variance = 0) {
  const actualDelay =
    variance > 0 ? ms + (Math.random() - 0.5) * 2 * variance : ms
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, actualDelay)))
}

async function* simulateStream(query) {
  const pattern = getSimulatorPattern(query)

  await delay(1000)

  if (pattern.thoughts) {
    const thoughtChunks = chunkText(pattern.thoughts, pattern.chunkSize || 5)
    for (const chunk of thoughtChunks) {
      yield `data: {"choices":[{"delta":{"reasoning_content":"${escapeJson(chunk)}"}}]}\n\n`
      await delay(pattern.streamDelayMs || 40)
    }

    if (pattern.thinkingDurationMs) {
      await delay(pattern.thinkingDurationMs)
    }
  }

  const contentChunks = chunkText(pattern.content, pattern.chunkSize || 7)
  for (const chunk of contentChunks) {
    yield `data: {"choices":[{"delta":{"content":"${escapeJson(chunk)}"}}]}\n\n`
    const variance = pattern.chunkSize === 1 ? pattern.streamDelayMs || 0 : 0
    await delay(pattern.streamDelayMs || 40, variance)
  }

  yield 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  yield 'data: [DONE]\n\n'
}

// ============================================================================
// HTTP Server
// ============================================================================

const localApiGateway = createLocalApiGateway({
  controlplaneUpstream: CONTROLPLANE_UPSTREAM,
})

const server = http.createServer(async (req, res) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  )
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const pathOnly = (req.url || '').split('?')[0]

  if (isDevStreamLogRequest(req)) {
    handleDevStreamLog(req, res)
    return
  }

  if (pathOnly !== '/api/dev/simulator') {
    await localApiGateway.route(req, res)
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, {
      Allow: 'POST',
      'Content-Type': 'application/json',
    })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    return
  }

  // Parse request body
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }

  let messages = []
  try {
    const parsed = JSON.parse(body)
    messages = parsed.messages || []
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  // Get the last user message
  const lastUserMessage = messages.filter((m) => m.role === 'user').pop()
  if (!lastUserMessage) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('No user message found')
    return
  }

  const query = lastUserMessage.content || ''

  // Set up streaming response headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
  })

  // Disable Nagle's algorithm
  if (req.socket) {
    req.socket.setNoDelay(true)
  }

  // Handle client disconnect
  let disconnected = false
  req.on('close', () => {
    disconnected = true
  })

  try {
    for await (const chunk of simulateStream(query)) {
      if (disconnected) break
      res.write(chunk)
    }
  } catch (error) {
    console.error('Dev simulator streaming error:', error)
  } finally {
    res.end()
  }
})

server.listen(PORT, () => {
  console.log(`🧪 Dev simulator server running at http://localhost:${PORT}`)
  console.log(`   Endpoint: POST http://localhost:${PORT}/api/dev/simulator`)
  console.log(
    `   Controlplane fallback: ${CONTROLPLANE_UPSTREAM || '(unconfigured; 502)'}`,
  )
  console.log('')
  console.log('   Mock controlplane endpoints:')
  console.log(`     - GET    /api/users/me/safeguard-flags`)
  console.log(`     - POST   /api/dev/safeguard-flags`)
  console.log(`     - DELETE /api/dev/safeguard-flags`)
  console.log('')
  console.log('   Test patterns:')
  console.log('     - "test thoughts" - Basic thinking + content')
  console.log('     - "test long thoughts" - Extended thinking phase')
  console.log('     - "test no thoughts" - Direct content, no thinking')
  console.log('     - "test code" - Code block output')
  console.log('     - "test rapid" - Fast streaming test')
  console.log('')
})
