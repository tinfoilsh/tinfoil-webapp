import {
  deleteChatRecovery,
  fetchRecoveredChatResponse,
  getChatRecoveryStatus,
} from '@/services/inference/chat-recovery-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const decryptResponseWithToken = vi.fn()

vi.mock('tinfoil', () => ({
  decryptResponseWithToken: (...args: unknown[]) =>
    decryptResponseWithToken(...args),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  getRecoveryBaseURL: vi.fn(() => 'https://api.example'),
}))

const SESSION_ID = '0123456789abcdef0123456789abcdef'

describe('chat recovery client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    decryptResponseWithToken.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([0, 128])(
    'reads complete recovery status with %s bytes without sending credentials',
    async (bytes) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'complete', bytes }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await expect(getChatRecoveryStatus(SESSION_ID)).resolves.toEqual({
        state: 'complete',
        persistedBytes: bytes,
      })
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.example/recovery/${SESSION_ID}/status`,
        expect.objectContaining({
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }),
      )
    },
  )

  it('preserves the underlying recovery transport error', async () => {
    const networkError = new TypeError('network unavailable')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError)

    await expect(getChatRecoveryStatus(SESSION_ID)).rejects.toMatchObject({
      cause: networkError,
      retryable: true,
    })
  })

  it('rejects a null recovery status response with a typed error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('null', {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(getChatRecoveryStatus(SESSION_ID)).rejects.toMatchObject({
      name: 'ChatRecoveryError',
      retryable: false,
    })
  })

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects recovery status with invalid persisted bytes %s',
    async (bytes) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'processing', bytes }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await expect(getChatRecoveryStatus(SESSION_ID)).rejects.toMatchObject({
        name: 'ChatRecoveryError',
        retryable: false,
      })
    },
  )

  it('decrypts the recovered encrypted response with the EHBP token', async () => {
    const encrypted = new Response('encrypted')
    const decrypted = new Response('decrypted')
    const token = {
      exportedSecret: new Uint8Array(32),
      requestEnc: new Uint8Array(32),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(encrypted)
    decryptResponseWithToken.mockResolvedValue(decrypted)

    await expect(fetchRecoveredChatResponse(SESSION_ID, token)).resolves.toBe(
      decrypted,
    )
    expect(decryptResponseWithToken).toHaveBeenCalledWith(encrypted, token)
  })

  it('decrypts an authenticated upstream conflict response', async () => {
    const encrypted = new Response('encrypted conflict', {
      status: 409,
      headers: { 'Ehbp-Response-Nonce': 'nonce' },
    })
    const decrypted = new Response('decrypted conflict', { status: 409 })
    const token = {
      exportedSecret: new Uint8Array(32),
      requestEnc: new Uint8Array(32),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(encrypted)
    decryptResponseWithToken.mockResolvedValue(decrypted)

    await expect(fetchRecoveredChatResponse(SESSION_ID, token)).resolves.toBe(
      decrypted,
    )
    expect(decryptResponseWithToken).toHaveBeenCalledWith(encrypted, token)
  })

  it('keeps a recovery stream tied to its scan signal', async () => {
    const encrypted = new Response('encrypted')
    const decrypted = new Response('decrypted')
    const token = {
      exportedSecret: new Uint8Array(32),
      requestEnc: new Uint8Array(32),
    }
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(encrypted)
    decryptResponseWithToken.mockResolvedValue(decrypted)

    await fetchRecoveredChatResponse(SESSION_ID, token, controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/recovery/${SESSION_ID}`,
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('counts each encrypted chunk and preserves replay bytes', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const encryptedProgress = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk))
            controller.close()
          },
        }),
      ),
    )
    decryptResponseWithToken.mockImplementation(async (response: Response) => {
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4, 5]),
      )
      return new Response('decrypted')
    })

    const response = await fetchRecoveredChatResponse(
      SESSION_ID,
      {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32),
      },
      undefined,
      encryptedProgress,
    )

    expect(await response.text()).toBe('decrypted')
    expect(encryptedProgress.mock.calls).toEqual([[0], [2], [3]])
  })

  it.each([
    [404, 'missing'],
    [410, 'failed'],
  ])('treats a %s recovery response as terminal', async (status, state) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status }),
    )

    await expect(
      fetchRecoveredChatResponse(SESSION_ID, {
        exportedSecret: new Uint8Array(32),
        requestEnc: new Uint8Array(32),
      }),
    ).rejects.toMatchObject({ state, retryable: false })
  })

  it('treats deletion of an already-missing session as success', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))

    await expect(deleteChatRecovery(SESSION_ID)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://api.example/recovery/${SESSION_ID}`,
      {
        method: 'DELETE',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: expect.any(AbortSignal),
      },
    )
    await expect(deleteChatRecovery(SESSION_ID)).rejects.toMatchObject({
      name: 'ChatRecoveryError',
      retryable: true,
    })
  })
})
