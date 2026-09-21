import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  handleDevStreamLog,
  isDevStreamLogRequest,
} from '../../scripts/dev-stream-log.mjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function requestStreamLog(body) {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-log-'))
  tempDirs.push(logsDir)
  const server = http.createServer((req, res) => {
    if (isDevStreamLogRequest(req)) {
      handleDevStreamLog(req, res, { logsDir })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()

  try {
    const payload = JSON.stringify(body)
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/dev/stream-log',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
    return { status, logsDir }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('development stream logger', () => {
  it('recognizes only the stream-log POST route', () => {
    expect(
      isDevStreamLogRequest({
        method: 'POST',
        url: '/api/dev/stream-log',
      }),
    ).toBe(true)
    expect(
      isDevStreamLogRequest({ method: 'GET', url: '/api/dev/stream-log' }),
    ).toBe(false)
  })

  it('writes a per-chat transcript', async () => {
    const { status, logsDir } = await requestStreamLog({
      chatId: 'chat-1',
      events: [
        {
          type: 'parsed',
          data: { choices: [{ delta: { content: 'Hello' } }] },
        },
      ],
    })

    expect(status).toBe(200)
    expect(
      fs.readFileSync(path.join(logsDir, 'chat-chat-1.md'), 'utf8'),
    ).toContain('Hello')
  })
})
