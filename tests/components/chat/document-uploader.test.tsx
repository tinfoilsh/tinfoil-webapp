import { useDocumentUploader } from '@/components/chat/document-uploader'
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

  it('converts two documents at a time across every uploader in the tab', async () => {
    const sidebar = renderHook(() => useDocumentUploader())
    const chat = renderHook(() => useDocumentUploader())
    const answers: Array<(response: Response) => void> = []
    mocks.secureFetch.mockImplementation(
      () => new Promise<Response>((resolve) => answers.push(resolve)),
    )
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

    answers[0](converted('first'))
    await vi.waitFor(() => expect(mocks.secureFetch).toHaveBeenCalledTimes(3))
    answers[1](converted('second'))
    answers[2](converted('third'))
    await act(async () => {
      await Promise.all(uploads)
    })

    expect(onError).not.toHaveBeenCalled()
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
      return new Promise<Response>((resolve) => answers.push(resolve))
    })
    const { result } = renderHook(() => useDocumentUploader())
    const onError = vi.fn()

    let uploads!: Promise<void>[]
    act(() => {
      uploads = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) =>
        result.current.handleDocumentUpload(pdf(name), vi.fn(), onError),
      )
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.secureFetch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(11 * 60_000)
    answers[0](converted('first'))
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.secureFetch).toHaveBeenCalledTimes(3)
    expect(signals[2]?.aborted).toBe(false)
    answers[1](converted('second'))
    answers[2](converted('third'))
    await act(async () => {
      await Promise.all(uploads)
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([429, 503])(
    'retries a %i after the delay the service asks for',
    async (status) => {
      vi.useFakeTimers()
      mocks.secureFetch
        .mockResolvedValueOnce(rejected(status, '1'))
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
