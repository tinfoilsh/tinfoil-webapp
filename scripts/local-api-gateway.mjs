import { proxyRequest } from './http-proxy.mjs'
import { createMockControlplane } from './mock-controlplane.mjs'

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

export function createLocalApiGateway({
  controlplaneUpstream,
  mockControlplane = createMockControlplane(),
  proxy = proxyRequest,
} = {}) {
  return {
    async route(req, res) {
      const mockResponse = mockControlplane.route(req, res)
      if (mockResponse !== null) {
        await mockResponse
        return
      }

      const pathOnly = (req.url || '').split('?')[0]
      if (pathOnly.startsWith('/api/dev/')) {
        send(
          res,
          404,
          'application/json',
          JSON.stringify({ error: 'Not found' }),
        )
        return
      }

      if (!pathOnly.startsWith('/api/')) {
        send(
          res,
          404,
          'application/json',
          JSON.stringify({ error: 'Not found' }),
        )
        return
      }

      if (!controlplaneUpstream) {
        send(
          res,
          502,
          'text/plain',
          'NEXT_PUBLIC_API_BASE_URL is not configured; cannot forward controlplane request.',
        )
        return
      }

      proxy(req, res, controlplaneUpstream)
    },
  }
}
