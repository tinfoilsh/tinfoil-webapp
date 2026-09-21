import http from 'node:http'
import https from 'node:https'

export function parseProxyOrigin(raw) {
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return `${url.protocol}//${url.host}`
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
    proxyRes.pipe(res, { end: true })
  })

  proxyReq.on('error', (error) => {
    console.error(`Proxy error → ${upstream}: ${error.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end('Bad Gateway')
  })

  req.pipe(proxyReq, { end: true })
}
