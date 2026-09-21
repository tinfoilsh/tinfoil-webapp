import { describe, expect, it, vi } from 'vitest'
import { createLocalApiGateway } from '../../scripts/local-api-gateway.mjs'

function makeResponse() {
  return { writeHead: vi.fn(), end: vi.fn() }
}

describe('local API gateway', () => {
  it('lets registered controlplane mocks own their routes', async () => {
    const mockControlplane = {
      route: vi.fn((_req, res) => {
        res.writeHead(200)
        res.end('mocked')
        return Promise.resolve()
      }),
    }
    const proxy = vi.fn()
    const req = { url: '/api/mock/example', method: 'GET' }
    const res = makeResponse()
    const gateway = createLocalApiGateway({
      controlplaneUpstream: 'https://api.tinfoil.sh',
      mockControlplane,
      proxy,
    })

    await gateway.route(req, res)

    expect(mockControlplane.route).toHaveBeenCalledWith(req, res)
    expect(res.writeHead).toHaveBeenCalledWith(200)
    expect(proxy).not.toHaveBeenCalled()
  })

  it('forwards unhandled API routes to the configured controlplane', async () => {
    const mockControlplane = { route: vi.fn(() => null) }
    const proxy = vi.fn()
    const req = {
      url: '/api/config/models?chat=true',
      method: 'GET',
      headers: { authorization: 'Bearer token' },
    }
    const res = makeResponse()
    const gateway = createLocalApiGateway({
      controlplaneUpstream: 'https://api.tinfoil.sh',
      mockControlplane,
      proxy,
    })

    await gateway.route(req, res)

    expect(proxy).toHaveBeenCalledWith(req, res, 'https://api.tinfoil.sh')
  })

  it('never forwards unknown development-only routes to controlplane', async () => {
    const proxy = vi.fn()
    const res = makeResponse()
    const gateway = createLocalApiGateway({
      controlplaneUpstream: 'https://api.tinfoil.sh',
      mockControlplane: { route: () => null },
      proxy,
    })

    await gateway.route({ url: '/api/dev/not-registered', method: 'POST' }, res)

    expect(res.writeHead).toHaveBeenCalledWith(404, {
      'Content-Type': 'application/json',
    })
    expect(proxy).not.toHaveBeenCalled()
  })

  it('returns 502 instead of dropping unhandled APIs when no upstream is configured', async () => {
    const res = makeResponse()
    const gateway = createLocalApiGateway({
      mockControlplane: { route: () => null },
      proxy: vi.fn(),
    })

    await gateway.route({ url: '/api/config/models', method: 'GET' }, res)

    expect(res.writeHead).toHaveBeenCalledWith(502, {
      'Content-Type': 'text/plain',
    })
  })
})
