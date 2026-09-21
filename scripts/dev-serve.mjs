#!/usr/bin/env node
/**
 * Serves the static production build (out/) with API proxying.
 *
 * Proxies:
 *   /api/local-router/* → http://localhost:8090/*
 *   /api/*              → http://localhost:3001/api/* (local API gateway)
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
import { proxyRequest } from './dev-http-proxy.mjs'

const PORT = 3000
const ROUTER_UPSTREAM = 'http://localhost:8090'
const SIMULATOR_UPSTREAM = 'http://localhost:3001'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out')

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

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://localhost').pathname
  if (urlPath.endsWith('/')) urlPath += 'index.html'

  let filePath = path.resolve(OUT_DIR, '.' + urlPath)
  if (!filePath.startsWith(path.resolve(OUT_DIR))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  if (!fs.existsSync(filePath)) {
    const withHtml = filePath + '.html'
    if (fs.existsSync(withHtml)) {
      filePath = withHtml
    } else {
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

  const contentType =
    MIME_TYPES[path.extname(filePath)] || 'application/octet-stream'
  const stream = fs.createReadStream(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  stream.pipe(res)
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
}

export function createDevServeHandler({
  simulatorUpstream = SIMULATOR_UPSTREAM,
  routerUpstream = ROUTER_UPSTREAM,
} = {}) {
  return function handle(req, res) {
    const pathOnly = (req.url || '').split('?')[0]

    if (
      pathOnly === '/api/local-router' ||
      pathOnly.startsWith('/api/local-router/')
    ) {
      proxyRequest(req, res, routerUpstream, {
        rewritePath: (url) => url.replace('/api/local-router', '') || '/',
      })
      return
    }

    if (pathOnly.startsWith('/api/')) {
      proxyRequest(req, res, simulatorUpstream)
      return
    }

    serveStatic(req, res)
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
const server = isMain ? http.createServer(createDevServeHandler()) : null

if (server) {
  server.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`)
    console.log(`  Static files: ${OUT_DIR}`)
    console.log(`  Proxy: /api/local-router/* → ${ROUTER_UPSTREAM}`)
    console.log(`  Proxy: /api/*              → ${SIMULATOR_UPSTREAM}`)
  })
}
