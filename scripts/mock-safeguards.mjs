/**
 * In-memory mock of the controlplane safeguard-flags API for local dev.
 *
 * Exposed as a factory (`createMockSafeguardsStore`) so tests can drive the
 * handler without binding a port. The frontend proxies both
 * `GET  /api/users/me/safeguard-flags` and the dev-only
 * `POST/DELETE /api/dev/safeguard-flags` here.
 *
 * The mock never validates the Clerk JWT cryptographically. It only requires
 * a well-formed `Authorization: Bearer <token>` header so signed-out behavior
 * is still exercised. Token values are never logged.
 */

const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_POLICY = Object.freeze({
  window_hours: 168,
  warn_threshold: 8,
  ban_threshold: 10,
})
const MS_PER_HOUR = 60 * 60 * 1000
const CONVERSATION_ID_MAX = 512
const BEARER_RE = /^Bearer\s+\S+/i

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isValidConversationId(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= CONVERSATION_ID_MAX
  )
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Payload too large')
      err.code = 'ERR_BODY_TOO_LARGE'
      throw err
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const err = new Error('Invalid JSON')
    err.code = 'ERR_INVALID_JSON'
    throw err
  }
}

function requireAuth(req, res) {
  const header = req.headers.authorization || req.headers.Authorization
  if (!header || !BEARER_RE.test(String(header))) {
    sendJson(res, 401, { error: 'Missing or malformed Authorization header.' })
    return false
  }
  return true
}

export function createMockSafeguardsStore({
  logger = console,
  policy = DEFAULT_POLICY,
} = {}) {
  // Newest-first, dedup by conversation_id.
  /** @type {{ id: string, conversation_id: string, created_at: string }[]} */
  const flags = []

  const listFlags = () => {
    const cutoff = Date.now() - policy.window_hours * MS_PER_HOUR
    const inWindow = flags.reduce(
      (n, f) => (Date.parse(f.created_at) >= cutoff ? n + 1 : n),
      0,
    )
    return {
      flags: flags.map((f) => ({ ...f })),
      in_window: inWindow,
      window_hours: policy.window_hours,
      warn_threshold: policy.warn_threshold,
      ban_threshold: policy.ban_threshold,
    }
  }

  const addFlag = (conversationId) => {
    const existing = flags.find((f) => f.conversation_id === conversationId)
    if (existing) return { flag: existing, duplicate: true }
    const flag = {
      id: `dev-safeguard:${conversationId}`,
      conversation_id: conversationId,
      created_at: new Date().toISOString(),
    }
    flags.unshift(flag)
    return { flag, duplicate: false }
  }

  const reset = () => {
    const cleared = flags.length
    flags.length = 0
    return cleared
  }

  async function handleGetFlags(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendJson(res, 405, { error: 'Method Not Allowed' })
      return
    }
    if (!requireAuth(req, res)) return
    sendJson(res, 200, listFlags())
  }

  async function handleDevFlags(req, res) {
    if (!requireAuth(req, res)) return
    if (req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        if (err.code === 'ERR_BODY_TOO_LARGE') {
          sendJson(res, 413, { error: 'Payload too large' })
        } else {
          sendJson(res, 400, { error: 'Invalid JSON body' })
        }
        return
      }
      const conversationId = body?.conversation_id
      if (!isValidConversationId(conversationId)) {
        sendJson(res, 400, {
          error: 'conversation_id is required and must be a non-empty string.',
        })
        return
      }
      const { duplicate } = addFlag(conversationId.trim())
      // Log without any token material.
      logger.log?.(
        `  Mock safeguard flag ${duplicate ? 'exists' : 'added'}: ${conversationId.trim()}`,
      )
      sendJson(res, 200, { created: !duplicate, duplicate })
      return
    }
    if (req.method === 'DELETE') {
      const cleared = reset()
      logger.log?.(`  Mock safeguard flags cleared (${cleared})`)
      sendJson(res, 200, { cleared })
      return
    }
    res.setHeader('Allow', 'POST, DELETE')
    sendJson(res, 405, { error: 'Method Not Allowed' })
  }

  return {
    listFlags,
    addFlag,
    reset,
    handleGetFlags,
    handleDevFlags,
    /** Convenience router used by dev-simulator server. */
    route(req, res) {
      const url = req.url || ''
      // Ignore query string for routing.
      const path = url.split('?')[0]
      if (path === '/api/users/me/safeguard-flags') {
        return handleGetFlags(req, res)
      }
      if (path === '/api/dev/safeguard-flags') {
        return handleDevFlags(req, res)
      }
      return null
    },
  }
}

export const MOCK_SAFEGUARDS_DEFAULT_POLICY = DEFAULT_POLICY
