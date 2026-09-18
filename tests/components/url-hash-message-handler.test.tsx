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
  setLocation('/')
})

describe('UrlHashMessageHandler', () => {
  it('sends the ?q= message and clears the marker through the router', () => {
    setLocation('/newchat?q=hello+world&view=compact')
    const onMessageReady = vi.fn()

    render(<UrlHashMessageHandler onMessageReady={onMessageReady} isReady />)

    expect(onMessageReady).toHaveBeenCalledExactlyOnceWith('hello world')
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith(
      '/newchat?view=compact',
      undefined,
      { shallow: true },
    )
  })

  it('sends the #send= message and drops both markers', () => {
    const encoded = Buffer.from('what is 2+2?').toString('base64')
    setLocation(`/?q=ignored#send=${encoded}`)
    const onMessageReady = vi.fn()

    render(<UrlHashMessageHandler onMessageReady={onMessageReady} isReady />)

    expect(onMessageReady).toHaveBeenCalledExactlyOnceWith('what is 2+2?')
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith('/', undefined, {
      shallow: true,
    })
  })

  it('falls back to a direct history swap if the router navigation rejects', async () => {
    routerReplace.mockRejectedValueOnce(new Error('route cancelled'))
    setLocation('/newchat?q=secret')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    render(<UrlHashMessageHandler onMessageReady={vi.fn()} isReady />)
    await vi.waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(null, '', '/newchat'),
    )
    replaceState.mockRestore()
  })

  it('waits until ready and does nothing without a marker', () => {
    setLocation('/newchat?q=later')
    const onMessageReady = vi.fn()
    const { rerender } = render(
      <UrlHashMessageHandler onMessageReady={onMessageReady} isReady={false} />,
    )
    expect(onMessageReady).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()

    rerender(<UrlHashMessageHandler onMessageReady={onMessageReady} isReady />)
    expect(onMessageReady).toHaveBeenCalledOnce()

    routerReplace.mockClear()
    setLocation('/settings#settings/privacy')
    render(<UrlHashMessageHandler onMessageReady={vi.fn()} isReady />)
    expect(routerReplace).not.toHaveBeenCalled()
  })
})
