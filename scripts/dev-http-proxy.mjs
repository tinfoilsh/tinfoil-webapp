import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream'

export function parseProxyOrigin(raw) {
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return `${url.protocol}//${url.host}`
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return isLoopbackHttp ? `${url.protocol}//${url.host}` : null
}

function handleProxyError(error, res, upstream) {
  console.error(`Proxy error → ${upstream}: ${error.message}`)
  if (res.destroyed) return
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad Gateway')
    return
  }
  res.destroy(error)
}

export function proxyRequest(req, res, upstream, { rewritePath } = {}) {
  const url = new URL(upstream)
  const transport = url.protocol === 'https:' ? https : http
  const port = url.port || (url.protocol === 'https:' ? 443 : 80)
  const targetPath =
    typeof rewritePath === 'function' ? rewritePath(req.url) : req.url
  const options = {
    hostname: url.hostname,
    port,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  }

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    pipeline(proxyRes, res, (error) => {
      if (error) handleProxyError(error, res, upstream)
    })
  })

  pipeline(req, proxyReq, (error) => {
    if (error) handleProxyError(error, res, upstream)
  })
}
