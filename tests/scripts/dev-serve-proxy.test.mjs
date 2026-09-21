import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDevServeHandler } from '../../scripts/dev-serve.mjs'

/**
 * Boots a small upstream that records every request, then drives the
 * dev-serve handler in-process to verify route precedence: mock safeguards,
 * dev-simulator, local-router, and catch-all controlplane, without falling
 * through to production for the mocked safeguard GET when the mock upstream
 * is unavailable.
 */

function makeRecordingServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        host: req.headers.host,
        body,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echoedFrom: req.headers.host }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${port}`,
      })
    })
  })
}

function nodeRequest({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(headers || {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function driveHandler(handler, { method, path, headers, body } = {}) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    return await nodeRequest({ port, method, path, headers, body })
  } finally {
    await new Promise((r) => server.close(r))
  }
}

describe('dev-serve route precedence', () => {
  let simulator
  let router
  let controlplane

  beforeEach(async () => {
    simulator = await makeRecordingServer()
    router = await makeRecordingServer()
    controlplane = await makeRecordingServer()
  })

  afterEach(async () => {
    await Promise.all(
      [simulator, router, controlplane].map(
        (s) => new Promise((r) => s.server.close(r)),
      ),
    )
  })

  function handler(overrides = {}) {
    return createDevServeHandler({
      simulatorUpstream: simulator.url,
      routerUpstream: router.url,
      controlplaneUpstream: controlplane.url,
      ...overrides,
    })
  }

  it('routes GET /api/users/me/safeguard-flags to the mock backend, preserving Authorization', async () => {
    const res = await driveHandler(handler(), {
      method: 'GET',
      path: '/api/users/me/safeguard-flags?x=1',
      headers: { Authorization: 'Bearer local' },
    })
    expect(res.status).toBe(200)
    expect(simulator.requests).toHaveLength(1)
    expect(simulator.requests[0]).toMatchObject({
      method: 'GET',
      url: '/api/users/me/safeguard-flags?x=1',
      authorization: 'Bearer local',
    })
    expect(controlplane.requests).toHaveLength(0)
    expect(router.requests).toHaveLength(0)
  })

  it('routes dev safeguard POST and DELETE to the mock backend, not the controlplane', async () => {
    await driveHandler(handler(), {
      method: 'POST',
      path: '/api/dev/safeguard-flags',
      headers: {
        Authorization: 'Bearer x',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ conversation_id: 'c' }),
    })
    await driveHandler(handler(), {
      method: 'DELETE',
      path: '/api/dev/safeguard-flags',
      headers: { Authorization: 'Bearer x' },
    })
    expect(simulator.requests.map((r) => r.method)).toEqual(['POST', 'DELETE'])
    expect(controlplane.requests).toHaveLength(0)
  })

  it('forwards unrelated /api/* requests to the configured real controlplane, preserving query and Authorization', async () => {
    const res = await driveHandler(handler(), {
      method: 'GET',
      path: '/api/config/models?feature=new',
      headers: { Authorization: 'Bearer cp' },
    })
    expect(res.status).toBe(200)
    expect(controlplane.requests).toHaveLength(1)
    expect(controlplane.requests[0]).toMatchObject({
      method: 'GET',
      url: '/api/config/models?feature=new',
      authorization: 'Bearer cp',
    })
    // Host header replaced with upstream host, not our test server's.
    expect(controlplane.requests[0].host).toBe(new URL(controlplane.url).host)
    expect(simulator.requests).toHaveLength(0)
  })

  it('routes /api/local-router/* to the router with the prefix stripped', async () => {
    await driveHandler(handler(), {
      method: 'GET',
      path: '/api/local-router/v1/chat/completions',
    })
    expect(router.requests).toHaveLength(1)
    expect(router.requests[0].url).toBe('/v1/chat/completions')
    expect(controlplane.requests).toHaveLength(0)
  })

  it('returns 502 for the mocked safeguard GET when the local backend is unavailable, never falling through to production', async () => {
    // Close the mock upstream so the proxy attempt fails.
    await new Promise((r) => simulator.server.close(r))
    const res = await driveHandler(handler(), {
      method: 'GET',
      path: '/api/users/me/safeguard-flags',
      headers: { Authorization: 'Bearer x' },
    })
    expect(res.status).toBe(502)
    // Real controlplane must not have been consulted for the mocked route.
    expect(controlplane.requests).toHaveLength(0)
  })

  it('returns 502 for /api/* when controlplane is unconfigured, never silently succeeding', async () => {
    const res = await driveHandler(handler({ controlplaneUpstream: null }), {
      method: 'GET',
      path: '/api/config/models',
    })
    expect(res.status).toBe(502)
  })
})
