import { DriverClient } from '@/services/computer-use/driver-client'
import { DriverError } from '@/services/computer-use/types'
import { describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('DriverClient — detection', () => {
  it('parses GET /status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        installed: true,
        running: true,
        version: '0.1.0',
        images: [{ name: 'tahoe', os: 'mac', ready: true }],
      }),
    ) as unknown as typeof fetch
    const client = new DriverClient({ fetchImpl })

    const status = await client.getStatus()
    expect(status.running).toBe(true)
    expect(status.images[0].name).toBe('tahoe')
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/status')
    expect(init.method).toBe('GET')
  })

  it('reports unreachable when the fetch itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const client = new DriverClient({ fetchImpl })

    await expect(client.getStatus()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DriverError && e.unreachable && e.status === 0,
    )
  })
})

describe('DriverClient — error bodies', () => {
  it('surfaces the driver {error} body with the HTTP status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'unknown or ended session' }, 502),
    ) as unknown as typeof fetch
    const client = new DriverClient({
      fetchImpl,
      getAccessToken: async () => 'jwt',
    })

    await expect(
      client.action('s', { op: 'screenshot', payload: {} }),
    ).rejects.toMatchObject({
      status: 502,
      message: 'unknown or ended session',
    })
  })
})

describe('DriverClient — auth', () => {
  it('attaches the access JWT on consequential calls', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true }),
    ) as unknown as typeof fetch
    const client = new DriverClient({
      fetchImpl,
      getAccessToken: async () => 'the-jwt',
    })

    await client.end('sess_1')
    const [, init] = (fetchImpl as any).mock.calls[0]
    expect(init.headers['Authorization']).toBe('Bearer the-jwt')
    expect(JSON.parse(init.body)).toEqual({ session: 'sess_1' })
  })

  it('throws 401 before fetching when no access token is available', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new DriverClient({
      fetchImpl,
      getAccessToken: async () => null,
    })

    await expect(client.end('s')).rejects.toMatchObject({ status: 401 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the refresh credential as the bearer on /token (not the access token)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a', expires_at: 1, expires_in: 1 }),
    ) as unknown as typeof fetch
    const client = new DriverClient({ fetchImpl })

    await client.mintAccessToken('refresh-cred')
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/token')
    expect(init.headers['Authorization']).toBe('Bearer refresh-cred')
  })
})

describe('DriverClient — actions', () => {
  it('POSTs {session, op, payload} to /action', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    ) as unknown as typeof fetch
    const client = new DriverClient({
      fetchImpl,
      getAccessToken: async () => 'jwt',
    })

    await client.action('sess_9', { op: 'click', payload: { x: 1, y: 2 } })
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8765/action')
    expect(JSON.parse(init.body)).toEqual({
      session: 'sess_9',
      op: 'click',
      payload: { x: 1, y: 2 },
    })
  })
})
