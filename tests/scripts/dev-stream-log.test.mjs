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

async function requestStreamLog(
  body,
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-log-')),
) {
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
      req.setTimeout(2_000, () =>
        req.destroy(new Error('Stream log request timed out')),
      )
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
    for (const url of [
      '/api/other',
      '/api/dev/stream-log/',
      '/api/dev/stream-log?x=1',
    ]) {
      expect(isDevStreamLogRequest({ method: 'POST', url })).toBe(false)
    }
  })

  it('writes a per-chat transcript', async () => {
    const { status, logsDir } = await requestStreamLog({
      chatId: '../chat-1',
      events: [
        {
          type: 'parsed',
          data: { choices: [{ delta: { content: 'Hello ' } }] },
        },
        {
          type: 'parsed',
          data: { choices: [{ delta: { content: 'world' } }] },
        },
        {
          type: 'parsed',
          data: { choices: [{ delta: { reasoning_content: 'Consider.' } }] },
        },
        {
          type: 'parsed',
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { name: 'calc', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        },
      ],
    })

    expect(status).toBe(200)
    const second = await requestStreamLog(
      {
        chatId: '../chat-1',
        events: [
          {
            type: 'parsed',
            data: { choices: [{ delta: { content: 'Again.' } }] },
          },
        ],
      },
      logsDir,
    )
    expect(second.status).toBe(200)
    expect(fs.readdirSync(logsDir)).toEqual(['chat-___chat-1.md'])
    const transcript = fs.readFileSync(
      path.join(logsDir, 'chat-___chat-1.md'),
      'utf8',
    )
    expect(
      transcript.replace(
        /^## Turn @ .+ \((\d+) chunks\)$/gm,
        '## Turn ($1 chunks)',
      ),
    ).toBe(
      '# Chat ../chat-1\n\n\n## Turn (4 chunks)\n\n--- content ---\nHello world\n\n--- reasoning ---\nConsider.\n\n--- tool call args: calc#0 ---\n{}\n\n\n## Turn (1 chunks)\n\n--- content ---\nAgain.\n\n',
    )
  })
})
