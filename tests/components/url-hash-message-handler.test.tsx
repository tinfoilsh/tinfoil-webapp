import { UrlHashMessageHandler } from '@/components/url-hash-message-handler'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const routerReplace = vi.fn().mockResolvedValue(true)

vi.mock('next/router', () => ({
  useRouter: () => ({ replace: routerReplace }),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

function setLocation(path: string) {
  const url = new URL(path, 'https://chat.tinfoil.sh')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

afterEach(() => {
  routerReplace.mockClear()
  vi.restoreAllMocks()
  setLocation('/')
})

describe('UrlHashMessageHandler', () => {
  it('sends the ?q= message and clears the marker through the router', () => {
    setLocation('/newchat?q=hello+world&view=compact')
    const onSubmit = vi.fn()

    render(<UrlHashMessageHandler onSubmit={onSubmit} isReady />)

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'hello world' })
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith(
      '/newchat?view=compact',
      undefined,
      { shallow: true },
    )
  })

  it('sends the #send= message and drops both markers', () => {
    const encoded = Buffer.from('what is 2+2?').toString('base64')
    setLocation(`/?q=ignored#send=${encoded}`)
    const onSubmit = vi.fn()

    render(<UrlHashMessageHandler onSubmit={onSubmit} isReady />)

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'what is 2+2?' })
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith('/', undefined, {
      shallow: true,
    })
  })

  it('falls back to a direct history swap if the router navigation rejects', async () => {
    routerReplace.mockRejectedValueOnce(new Error('route cancelled'))
    setLocation('/newchat?q=secret')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    render(<UrlHashMessageHandler onSubmit={vi.fn()} isReady />)
    await vi.waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(null, '', '/newchat'),
    )
  })

  it('waits until ready and does nothing without a marker', () => {
    setLocation('/newchat?q=later')
    const onSubmit = vi.fn()
    const { rerender } = render(
      <UrlHashMessageHandler onSubmit={onSubmit} isReady={false} />,
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()

    rerender(<UrlHashMessageHandler onSubmit={onSubmit} isReady />)
    expect(onSubmit).toHaveBeenCalledOnce()

    routerReplace.mockClear()
    setLocation('/settings#settings/privacy')
    render(<UrlHashMessageHandler onSubmit={vi.fn()} isReady />)
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it.each(['fragment', 'query'])(
    'does not consume a %s message if enqueueing fails',
    (format) => {
      const path = format === 'fragment' ? '/#send=aGVsbG8=' : '/?q=hello'
      setLocation(path)
      const onSubmit = vi.fn().mockImplementationOnce(() => {
        throw new Error('Queue unavailable')
      })
      const { rerender } = render(
        <UrlHashMessageHandler onSubmit={onSubmit} isReady />,
      )
      expect(routerReplace).not.toHaveBeenCalled()
      expect(
        window.location.pathname +
          window.location.search +
          window.location.hash,
      ).toBe(path)
      rerender(<UrlHashMessageHandler onSubmit={onSubmit} isReady={false} />)
      rerender(<UrlHashMessageHandler onSubmit={onSubmit} isReady />)
      expect(onSubmit).toHaveBeenCalledTimes(2)
      expect(onSubmit).toHaveBeenLastCalledWith({ text: 'hello' })
      expect(routerReplace).toHaveBeenCalledOnce()
    },
  )
})
