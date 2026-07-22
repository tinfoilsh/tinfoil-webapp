import {
  deleteChatRecovery,
  fetchRecoveredChatResponse,
  getChatRecoveryState,
} from '@/services/inference/chat-recovery-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('reads complete recovery status without sending credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'complete' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(getChatRecoveryState(SESSION_ID)).resolves.toBe('complete')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/recovery/${SESSION_ID}/status`,
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    )
  })

  it('preserves the underlying recovery transport error', async () => {
    const networkError = new TypeError('network unavailable')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError)

    await expect(getChatRecoveryState(SESSION_ID)).rejects.toMatchObject({
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

    await expect(getChatRecoveryState(SESSION_ID)).rejects.toMatchObject({
      name: 'ChatRecoveryError',
      retryable: false,
    })
  })

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    )

    await expect(deleteChatRecovery(SESSION_ID)).resolves.toBeUndefined()
  })
})
