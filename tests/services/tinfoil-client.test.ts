import { AuthenticationError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Mimics TinfoilAI's internal createAsyncProxy — a 2-level proxy that
 * defers all method calls through a promise. This is what client.chat,
 * client.audio, etc. actually return.
 */
function createAsyncProxy(promise: Promise<any>): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return new Proxy(() => {}, {
          get(_, nestedProp) {
            return (...args: any[]) =>
              promise.then((obj) => {
                const value = obj[prop][nestedProp]
                return typeof value === 'function'
                  ? value.apply(obj[prop], args)
                  : value
              })
          },
          apply(_, __, args) {
            return promise.then((obj) => {
              const value = obj[prop]
              return typeof value === 'function'
                ? value.apply(obj, args)
                : value
            })
          },
        })
      },
    },
  )
}

/**
 * Creates a mock TinfoilAI-like object that uses the same async proxy
 * pattern as the real SDK.
 */
function createMockTinfoilClient(inner: any) {
  return {
    get chat() {
      return createAsyncProxy(Promise.resolve(inner).then((c) => c.chat))
    },
    get audio() {
      return createAsyncProxy(Promise.resolve(inner).then((c) => c.audio))
    },
    getVerificationDocument: inner.getVerificationDocument?.bind(inner),
  }
}

// We test the proxy logic in isolation by extracting it from tinfoil-client.ts
// and wiring it up with mock clients.
function createRetryProxy(
  getClient: () => any,
  resetClient: () => void,
  refreshClient: () => Promise<void>,
): any {
  function resolvePath(path: PropertyKey[]): { fn: any; thisArg: any } {
    let thisArg: any = getClient()
    let fn: any = getClient()
    for (const p of path) {
      thisArg = fn
      fn = fn[p]
    }
    return { fn, thisArg }
  }

  function proxyWithRetry(pathFromRoot: PropertyKey[]): any {
    return new Proxy(function () {}, {
      get(_, prop) {
        if (
          prop === 'then' ||
          prop === Symbol.toPrimitive ||
          prop === Symbol.toStringTag
        ) {
          return undefined
        }
        return proxyWithRetry([...pathFromRoot, prop])
      },
      apply(_, __, args) {
        const { fn, thisArg } = resolvePath(pathFromRoot)
        const result = fn.apply(thisArg, args)
        if (result && typeof result.then === 'function') {
          return result.catch(async (err: unknown) => {
            if (err instanceof AuthenticationError) {
              resetClient()
              await refreshClient()
              const { fn: freshFn, thisArg: freshThis } =
                resolvePath(pathFromRoot)
              return freshFn.apply(freshThis, args)
            }
            throw err
          })
        }
        return result
      },
    })
  }

  return proxyWithRetry([])
}

describe('tinfoil-client retry proxy', () => {
  let currentClient: any
  let clientVersion: number

  function makeAuthError() {
    return new AuthenticationError(
      401,
      { error: { message: 'invalid api key' }, type: 'auth_error' },
      'invalid api key',
      new Headers(),
    )
  }

  function buildClient(createFn: ReturnType<typeof vi.fn>) {
    const inner = {
      chat: {
        completions: {
          create: createFn,
        },
      },
      audio: {
        transcriptions: {
          create: createFn,
        },
      },
      getVerificationDocument: vi.fn().mockResolvedValue({ verified: true }),
    }
    return createMockTinfoilClient(inner)
  }

  let staleCreateFn: ReturnType<typeof vi.fn>
  let freshCreateFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clientVersion = 0
    staleCreateFn = vi.fn()
    freshCreateFn = vi.fn()
    currentClient = buildClient(staleCreateFn)
  })

  function createProxy() {
    return createRetryProxy(
      () => currentClient,
      () => {
        currentClient = null
      },
      async () => {
        clientVersion++
        currentClient = buildClient(freshCreateFn)
      },
    )
  }

  it('should forward client.chat.completions.create() calls', async () => {
    staleCreateFn.mockResolvedValue({
      choices: [{ message: { content: 'hi' } }],
    })
    const proxy = createProxy()

    const result = await proxy.chat.completions.create({
      model: 'test',
      messages: [],
    })

    expect(result).toEqual({ choices: [{ message: { content: 'hi' } }] })
    expect(staleCreateFn).toHaveBeenCalledWith({ model: 'test', messages: [] })
  })

  it('should forward client.audio.transcriptions.create() calls', async () => {
    staleCreateFn.mockResolvedValue({ text: 'hello world' })
    const proxy = createProxy()

    const result = await proxy.audio.transcriptions.create({
      file: 'audio.mp3',
    })

    expect(result).toEqual({ text: 'hello world' })
    expect(staleCreateFn).toHaveBeenCalledWith({ file: 'audio.mp3' })
  })

  it('should forward client.getVerificationDocument() calls', async () => {
    const proxy = createProxy()
    const doc = await proxy.getVerificationDocument()

    expect(doc).toEqual({ verified: true })
  })

  it('should retry on AuthenticationError and succeed with fresh client', async () => {
    staleCreateFn.mockRejectedValue(makeAuthError())
    freshCreateFn.mockResolvedValue({
      choices: [{ message: { content: 'retried' } }],
    })
    const proxy = createProxy()

    const result = await proxy.chat.completions.create({
      model: 'test',
      messages: [],
    })

    expect(result).toEqual({ choices: [{ message: { content: 'retried' } }] })
    expect(staleCreateFn).toHaveBeenCalledTimes(1)
    expect(freshCreateFn).toHaveBeenCalledTimes(1)
    expect(clientVersion).toBe(1)
  })

  it('should propagate non-auth errors without retrying', async () => {
    const networkError = new Error('Network timeout')
    staleCreateFn.mockRejectedValue(networkError)
    const proxy = createProxy()

    await expect(
      proxy.chat.completions.create({ model: 'test', messages: [] }),
    ).rejects.toThrow('Network timeout')

    expect(staleCreateFn).toHaveBeenCalledTimes(1)
    expect(freshCreateFn).not.toHaveBeenCalled()
    expect(clientVersion).toBe(0)
  })

  it('should use fresh client for all calls after a retry (no stale-client bug)', async () => {
    staleCreateFn.mockRejectedValueOnce(makeAuthError())
    freshCreateFn.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    })
    const proxy = createProxy()

    // First call triggers retry
    await proxy.chat.completions.create({ model: 'test', messages: [] })

    // Second call should go directly to fresh client, not the stale one
    freshCreateFn.mockClear()
    staleCreateFn.mockClear()

    await proxy.chat.completions.create({ model: 'test2', messages: [] })

    expect(staleCreateFn).not.toHaveBeenCalled()
    expect(freshCreateFn).toHaveBeenCalledTimes(1)
    expect(freshCreateFn).toHaveBeenCalledWith({ model: 'test2', messages: [] })
  })

  it('should only retry once — a second AuthenticationError is thrown', async () => {
    staleCreateFn.mockRejectedValue(makeAuthError())
    freshCreateFn.mockRejectedValue(makeAuthError())
    const proxy = createProxy()

    await expect(
      proxy.chat.completions.create({ model: 'test', messages: [] }),
    ).rejects.toThrow(AuthenticationError)

    expect(clientVersion).toBe(1)
  })

  it('should not be thenable (await returns the proxy itself)', async () => {
    const proxy = createProxy()
    const awaited = await proxy
    expect(awaited).toBe(proxy)
  })

  it('should pass multiple arguments through correctly', async () => {
    staleCreateFn.mockResolvedValue({ choices: [] })
    const proxy = createProxy()
    const signal = new AbortController().signal

    await proxy.chat.completions.create(
      { model: 'test', messages: [] },
      { signal },
    )

    expect(staleCreateFn).toHaveBeenCalledWith(
      { model: 'test', messages: [] },
      { signal },
    )
  })
})
