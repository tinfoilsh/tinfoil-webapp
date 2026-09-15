import { API_BASE_URL } from '@/config'
import { AnonymousCredentialCache } from '@/services/harness/anonymous-credential'
import { HarnessClient } from '@/services/harness/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('tinfoil', () => ({ SecureClient: vi.fn() }))

const issuance = (key = 'free_first', remaining = 9) =>
  Response.json({
    key,
    is_free_tier: true,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    rate_limit: {
      max_requests: 10,
      remaining,
      resets_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  })

const controlplane = vi.fn<typeof fetch>()
function setup(getToken = async (): Promise<string | null> => null) {
  const secure = {
    ready: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(async () => Response.json({ ok: true })),
    getVerificationDocument: vi.fn(),
  }
  const client = new HarnessClient('https://harness.example', getToken, secure)
  return { client, secure }
}

beforeEach(() => {
  controlplane.mockReset().mockImplementation(async () => issuance())
  vi.stubGlobal('fetch', controlplane)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('anonymous client credentials', () => {
  it('deduplicates direct issuance and sends only the key through the attested transport', async () => {
    const { client, secure } = setup()
    await Promise.all([
      client.post('/v1/session', {}),
      client.upload('/v1/attachments/upload', new File(['text'], 'file.txt'), {
        ephemeral: 'true',
      }),
    ])
    expect(controlplane).toHaveBeenCalledTimes(1)
    expect(String(controlplane.mock.calls[0][0])).toBe(
      `${API_BASE_URL || 'https://api.tinfoil.sh'}/api/keys/chat`,
    )
    expect(controlplane.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
    expect(controlplane.mock.calls[0][1]?.headers).toBeUndefined()
    expect(controlplane.mock.calls[0][1]?.body).toBeUndefined()
    for (const [url, options] of secure.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/harness\.example\/v1\//)
      expect(new Headers(options.headers).get('Authorization')).toBe(
        'Bearer free_first',
      )
      expect(String(options.body)).not.toContain('free_first')
      expect(new Headers(options.headers).has('X-Tinfoil-Client-IP')).toBe(
        false,
      )
    }
    expect(client.anonymousRateLimit).toMatchObject({
      kind: 'free_daily',
      remaining: 9,
    })
    client.dispose()
    expect(client.anonymousRateLimit).toBeUndefined()
  })

  it('refreshes an expired key and retries a rejected key once with the same turn body', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const { client, secure } = setup()
    await client.session()
    clock.mockReturnValue(clock() + 3_600_001)
    controlplane.mockImplementationOnce(async () => issuance('free_second'))
    await client.session()
    expect(
      new Headers(secure.fetch.mock.calls[1][1].headers).get('Authorization'),
    ).toBe('Bearer free_second')
    secure.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    controlplane.mockImplementationOnce(async () => issuance('free_third'))
    const turn = {
      clientRequestId: 'same-nonce',
      ephemeral: true,
      content: 'hello',
    }
    await client.post('/v1/threads/turn', turn)
    expect(controlplane).toHaveBeenCalledTimes(3)
    const retries = secure.fetch.mock.calls.slice(2)
    expect(retries.map(([, options]) => options.body)).toEqual([
      JSON.stringify(turn),
      JSON.stringify(turn),
    ])
    expect(
      retries.map(([, options]) =>
        new Headers(options.headers).get('Authorization'),
      ),
    ).toEqual(['Bearer free_second', 'Bearer free_third'])
    client.dispose()
  })

  it('bounds repeated rejection and preserves quota errors without retrying issuance', async () => {
    const { client, secure } = setup()
    secure.fetch.mockImplementation(
      async () => new Response('{}', { status: 401 }),
    )
    await expect(client.session()).rejects.toMatchObject({ status: 401 })
    expect(secure.fetch).toHaveBeenCalledTimes(2)
    expect(controlplane).toHaveBeenCalledTimes(2)
    secure.fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: { code: 'QUOTA_EXHAUSTED', message: 'Daily quota exhausted' },
        },
        { status: 429 },
      ),
    )
    await expect(client.post('/v1/threads/turn', {})).rejects.toMatchObject({
      detail: { code: 'QUOTA_EXHAUSTED' },
    })
    expect(controlplane).toHaveBeenCalledTimes(2)
    expect(client.anonymousRateLimit?.remaining).toBe(0)
    client.dispose()
  })

  it('cancels one waiter without canceling shared issuance for another request', async () => {
    let resolve!: (response: Response) => void
    controlplane.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const cache = new AnonymousCredentialCache()
    const controller = new AbortController()
    const canceled = cache.get(controller.signal)
    const other = cache.get()
    controller.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    expect(controlplane.mock.calls[0][1]?.signal?.aborted).toBe(false)
    resolve(issuance())
    await expect(other).resolves.toBe('free_first')
    expect(controlplane).toHaveBeenCalledTimes(1)
    cache.dispose()
  })

  it('does not forward credentials from an account that changed during issuance', async () => {
    let resolve!: (response: Response) => void
    controlplane.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    let active = true
    const { client, secure } = setup(async () => {
      if (!active) throw new DOMException('Account changed', 'AbortError')
      return null
    })
    const request = client.session()
    await vi.waitFor(() => expect(controlplane).toHaveBeenCalledTimes(1))
    active = false
    resolve(issuance())
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(secure.fetch).not.toHaveBeenCalled()
    client.dispose()
  })

  it('discards a late issuance response after disposal', async () => {
    let resolve!: (response: Response) => void
    controlplane.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { client, secure } = setup()
    const request = client.session()
    await vi.waitFor(() => expect(controlplane).toHaveBeenCalledTimes(1))
    client.dispose()
    expect(controlplane.mock.calls[0][1]?.signal?.aborted).toBe(true)
    resolve(issuance())
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(secure.fetch).not.toHaveBeenCalled()
    expect(client.anonymousRateLimit).toBeUndefined()
  })

  it('rejects malformed issuance before contacting the harness', async () => {
    controlplane.mockResolvedValueOnce(
      Response.json({ key: 'free_forged', expires_at: 'invalid' }),
    )
    const { client, secure } = setup()
    await expect(client.session()).rejects.toMatchObject({
      detail: { code: 'UPSTREAM_REFUSED' },
    })
    expect(secure.fetch).not.toHaveBeenCalled()
    client.dispose()
  })

  it('refreshes quota metadata after a completed run without replaying the run', async () => {
    const { client, secure } = setup()
    secure.fetch.mockResolvedValueOnce(
      new Response('data: {"type":"RUN_FINISHED"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    for await (const frame of client.events('/v1/threads/follow', {
      threadId: 't',
      runId: 'r',
    }))
      expect(frame.event.type).toBe('RUN_FINISHED')
    expect(secure.fetch).toHaveBeenCalledTimes(1)
    controlplane.mockImplementationOnce(async () => issuance('free_first', 8))
    await client.session()
    expect(controlplane).toHaveBeenCalledTimes(2)
    expect(client.anonymousRateLimit?.remaining).toBe(8)
    expect(secure.fetch.mock.calls[1][0]).toBe(
      'https://harness.example/v1/session',
    )
    client.dispose()
  })
})
