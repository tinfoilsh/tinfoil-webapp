import { useDocumentUploader } from '@/components/chat/document-uploader'
import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  secureFetch:
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  getSessionToken: vi.fn<() => Promise<string>>(),
  getAIModels: vi.fn(),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  getSecureFetch: async () => mocks.secureFetch,
  getSessionToken: mocks.getSessionToken,
  getTinfoilClient: vi.fn(),
}))

vi.mock('@/config/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/models')>()),
  getAIModels: mocks.getAIModels,
}))

const CONVERT_ENDPOINT = 'https://inference.tinfoil.sh/v1/convert/file'

function pdf(name: string): File {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf' })
}

function converted(markdown: string): Response {
  return new Response(JSON.stringify({ document: { md_content: markdown } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rejected(status: number, retryAfter?: string): Response {
  return new Response('busy', {
    status,
    headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  })
}

describe('useDocumentUploader', () => {
  beforeEach(() => {
    mocks.secureFetch.mockReset()
    mocks.getSessionToken.mockReset().mockResolvedValue('session-token')
    mocks.getAIModels.mockReset().mockResolvedValue([
      {
        modelName: 'docling',
        type: 'document',
        endpoint: CONVERT_ENDPOINT,
        image: '',
        name: 'Docling',
        nameShort: 'Docling',
        description: '',
      },
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for asynchronous persistence callbacks to finish', async () => {
    const { result } = renderHook(() => useDocumentUploader())
    let resolvePersistence!: () => void
    const onSuccess = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersistence = resolve
        }),
    )
    let completed = false

    let uploadPromise!: Promise<void>
    act(() => {
      uploadPromise = result.current
        .handleDocumentUpload(
          new File(['Project context'], 'notes.txt', { type: 'text/plain' }),
          onSuccess,
          vi.fn(),
        )
        .then(() => {
          completed = true
        })
    })

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(completed).toBe(false)

    await act(async () => {
      resolvePersistence()
      await uploadPromise
    })
    expect(completed).toBe(true)
  })

  it('holds both slots until response bodies finish across uploaders in the tab', async () => {
    const sidebar = renderHook(() => useDocumentUploader())
    const chat = renderHook(() => useDocumentUploader())
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = []
    mocks.secureFetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              bodies.push(controller)
            },
          }),
        ),
    )
    const finish = (index: number, text: string) => {
      bodies[index].enqueue(
        new TextEncoder().encode(
          JSON.stringify({ document: { md_content: text } }),
        ),
      )
      bodies[index].close()
    }
    const onSuccess = vi.fn()
    const onError = vi.fn()

    let uploads!: Promise<void>[]
    act(() => {
      uploads = [
        sidebar.result.current.handleDocumentUpload(
          pdf('a.pdf'),
          onSuccess,
          onError,
        ),
        sidebar.result.current.handleDocumentUpload(
          pdf('b.pdf'),
          onSuccess,
          onError,
        ),
        chat.result.current.handleDocumentUpload(
          pdf('c.pdf'),
          onSuccess,
          onError,
        ),
      ]
    })

    await vi.waitFor(() => expect(mocks.secureFetch).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(mocks.secureFetch).toHaveBeenCalledTimes(2)
    expect(mocks.secureFetch.mock.calls[0][0]).toBe(CONVERT_ENDPOINT)
    expect(mocks.secureFetch.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'Bearer session-token',
    })

    expect(onSuccess).not.toHaveBeenCalled()
    finish(0, 'first')
    await vi.waitFor(() => expect(mocks.secureFetch).toHaveBeenCalledTimes(3))
    finish(1, 'second')
    finish(2, 'third')
    await act(async () => {
      await Promise.all(uploads)
    })

    expect(onError).not.toHaveBeenCalled()
    expect(
      mocks.secureFetch.mock.calls.map(([, init]) =>
        (init?.body as FormData).get('files'),
      ),
    ).toEqual([
      expect.objectContaining({ name: 'a.pdf' }),
      expect.objectContaining({ name: 'b.pdf' }),
      expect.objectContaining({ name: 'c.pdf' }),
    ])
    expect(onSuccess.mock.calls.map(([content]) => content).sort()).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('starts the processing deadline when a queued file starts converting', async () => {
    vi.useFakeTimers()
    const answers: Array<(response: Response) => void> = []
    const signals: Array<AbortSignal | null | undefined> = []
    mocks.secureFetch.mockImplementation((_endpoint, init) => {
      signals.push(init?.signal)
      return new Promise<Response>((resolve, reject) => {
        answers.push(resolve)
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        )
      })
    })
    const { result } = renderHook(() => useDocumentUploader())
    const onError = vi.fn()
    const onSuccess = vi.fn()

    let uploads!: Promise<void>[]
    act(() => {
      uploads = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) =>
        result.current.handleDocumentUpload(pdf(name), onSuccess, onError),
      )
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.secureFetch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(mocks.secureFetch).toHaveBeenCalledTimes(3)
    expect(signals[2]?.aborted).toBe(false)
    answers[2](converted('third'))
    await act(async () => {
      await Promise.all(uploads)
    })
    expect(onError.mock.calls.map(([error]) => error.name)).toEqual([
      'AbortError',
      'AbortError',
    ])
    expect(onSuccess.mock.calls.map(([content]) => content)).toEqual(['third'])
  })

  it.each([
    { status: 429, retryAfter: '1' },
    { status: 503, retryAfter: 'Tue, 13 Oct 2026 12:00:01 GMT' },
    { status: 429, retryAfter: '0' },
  ])(
    'retries $status after Retry-After $retryAfter with a one-second floor',
    async ({ status, retryAfter }) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
      mocks.secureFetch
        .mockResolvedValueOnce(rejected(status, retryAfter))
        .mockResolvedValueOnce(converted('Statement text'))
      const { result } = renderHook(() => useDocumentUploader())
      const onSuccess = vi.fn()
      const onError = vi.fn()

      let upload!: Promise<void>
      act(() => {
        upload = result.current.handleDocumentUpload(
          pdf('statement.pdf'),
          onSuccess,
          onError,
        )
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(mocks.secureFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await act(async () => {
        await upload
      })

      expect(mocks.secureFetch).toHaveBeenCalledTimes(2)
      expect(onError).not.toHaveBeenCalled()
      expect(onSuccess).toHaveBeenCalledWith(
        'Statement text',
        expect.any(String),
        undefined,
        undefined,
        undefined,
      )
    },
  )

  it.each([{ code: 'insufficient_quota' }, { type: 'insufficient_quota' }])(
    'does not retry a quota rejection with Retry-After: %j',
    async (error) => {
      const errorText = JSON.stringify({ error })
      mocks.secureFetch.mockResolvedValueOnce(
        new Response(errorText, {
          status: 429,
          headers: { 'Retry-After': '1' },
        }),
      )
      const { result } = renderHook(() => useDocumentUploader())
      const onError = vi.fn(),
        onSuccess = vi.fn()
      await act(async () => {
        await result.current.handleDocumentUpload(
          pdf('statement.pdf'),
          onSuccess,
          onError,
        )
      })
      expect(mocks.secureFetch).toHaveBeenCalledTimes(1)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0][0].message).toBe(
        `Document upload failed with status: 429. ${errorText}`,
      )
    },
  )

  it('discards old-account queued work and results, then accepts new-account files', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
    mocks.getSessionToken.mockResolvedValue('token-a')
    const answers: Array<(response: Response) => void> = []
    mocks.secureFetch.mockImplementation(
      () => new Promise<Response>((resolve) => answers.push(resolve)),
    )
    const { result } = renderHook(() => useDocumentUploader())
    const onSuccess = vi.fn(),
      onError = vi.fn()
    let uploads!: Promise<void>[]
    act(() => {
      uploads = ['a.pdf', 'b.pdf', 'queued.pdf'].map((name) =>
        result.current.handleDocumentUpload(pdf(name), onSuccess, onError),
      )
    })
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-b')
    window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    mocks.getSessionToken.mockResolvedValue('token-b')
    await act(async () => {
      answers[0](converted('private a'))
      answers[1](converted('private b'))
      await Promise.all(uploads)
    })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError.mock.calls.map(([error]) => error.name)).toEqual([
      'AbortError',
      'AbortError',
      'AbortError',
    ])
    expect(mocks.secureFetch).toHaveBeenCalledTimes(2)

    mocks.secureFetch.mockResolvedValueOnce(converted('new account content'))
    await act(async () => {
      await result.current.handleDocumentUpload(
        pdf('fresh.pdf'),
        onSuccess,
        onError,
      )
    })
    expect(
      mocks.secureFetch.mock.calls.map(([, init]) => [
        (init?.headers as Record<string, string>).Authorization,
        ((init?.body as FormData).get('files') as File).name,
      ]),
    ).toEqual([
      ['Bearer token-a', 'a.pdf'],
      ['Bearer token-a', 'b.pdf'],
      ['Bearer token-b', 'fresh.pdf'],
    ])
    expect(onSuccess.mock.calls.map(([content]) => content)).toEqual([
      'new account content',
    ])
  })

  it('does not send when the account switches while credentials are being fetched', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
    let answer!: (token: string) => void
    mocks.getSessionToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
    )
    const { result } = renderHook(() => useDocumentUploader())
    const onSuccess = vi.fn(),
      onError = vi.fn()
    let upload!: Promise<void>
    act(() => {
      upload = result.current.handleDocumentUpload(
        pdf('private.pdf'),
        onSuccess,
        onError,
      )
    })
    await vi.waitFor(() => expect(answer).toBeDefined())
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-b')
    await act(async () => {
      answer('token-b')
      await upload
    })
    expect(mocks.secureFetch).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].name).toBe('AbortError')
  })

  it('does not retry under another account after a capacity delay', async () => {
    vi.useFakeTimers()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-a')
    mocks.secureFetch.mockResolvedValueOnce(rejected(429, '1'))
    const { result } = renderHook(() => useDocumentUploader())
    const onError = vi.fn(),
      onSuccess = vi.fn()
    let upload!: Promise<void>
    act(() => {
      upload = result.current.handleDocumentUpload(
        pdf('private.pdf'),
        onSuccess,
        onError,
      )
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.secureFetch).toHaveBeenCalledOnce()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-b')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      await upload
    })
    expect(mocks.secureFetch).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].name).toBe('AbortError')
  })

  it.each([
    ['names no delay', undefined],
    ['asks for a delay past the processing deadline', '601'],
  ])('reports a capacity rejection that %s', async (_case, retryAfter) => {
    mocks.secureFetch.mockResolvedValueOnce(rejected(429, retryAfter))
    const { result } = renderHook(() => useDocumentUploader())
    const onSuccess = vi.fn()
    const onError = vi.fn()

    await act(async () => {
      await result.current.handleDocumentUpload(
        pdf('statement.pdf'),
        onSuccess,
        onError,
      )
    })

    expect(mocks.secureFetch).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toBe(
      'Document upload failed with status: 429. busy',
    )
  })
})
