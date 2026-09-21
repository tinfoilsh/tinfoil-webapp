import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDevServeHandler } from '../../scripts/dev-serve.mjs'

function makeRecordingServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        host: req.headers.host,
        body,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, requests, url: `http://127.0.0.1:${port}` })
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
        res.on('data', (chunk) => chunks.push(chunk))
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await nodeRequest({ port, method, path, headers, body })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('dev-serve route precedence', () => {
  let gateway
  let router

  beforeEach(async () => {
    gateway = await makeRecordingServer()
    router = await makeRecordingServer()
  })

  afterEach(async () => {
    await Promise.all(
      [gateway, router].map((server) =>
        server.server.listening
          ? new Promise((resolve) => server.server.close(resolve))
          : Promise.resolve(),
      ),
    )
  })

  function handler() {
    return createDevServeHandler({
      simulatorUpstream: gateway.url,
      routerUpstream: router.url,
    })
  }

  it.each([
    ['GET', '/api/users/me/safeguard-flags?x=1'],
    ['POST', '/api/dev/safeguard-flags'],
    ['DELETE', '/api/dev/safeguard-flags'],
    ['GET', '/api/config/models?feature=new'],
  ])('routes %s %s through the local API gateway', async (method, path) => {
    const response = await driveHandler(handler(), {
      method,
      path,
      headers: { Authorization: 'Bearer local' },
    })

    expect(response.status).toBe(200)
    expect(gateway.requests).toHaveLength(1)
    expect(gateway.requests[0]).toMatchObject({
      method,
      url: path,
      authorization: 'Bearer local',
      host: new URL(gateway.url).host,
    })
    expect(router.requests).toHaveLength(0)
  })

  it('routes /api/local-router/* directly to the model router', async () => {
    await driveHandler(handler(), {
      method: 'GET',
      path: '/api/local-router/v1/chat/completions',
    })

    expect(router.requests).toHaveLength(1)
    expect(router.requests[0].url).toBe('/v1/chat/completions')
    expect(gateway.requests).toHaveLength(0)
  })

  it('returns 502 when the local API gateway is unavailable', async () => {
    await new Promise((resolve) => gateway.server.close(resolve))

    const response = await driveHandler(handler(), {
      method: 'GET',
      path: '/api/users/me/safeguard-flags',
      headers: { Authorization: 'Bearer local' },
    })

    expect(response.status).toBe(502)
  })
})
