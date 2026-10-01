import { useChatRouter } from '@/hooks/use-chat-router'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockUseRouter = vi.fn()

vi.mock('next/router', () => ({
  useRouter: () => mockUseRouter(),
}))

describe('useChatRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it.each([
    {
      name: 'blank chat',
      update: (router: ReturnType<typeof useChatRouter>) => router.clearUrl(),
      path: '/',
    },
    {
      name: 'cloud chat',
      update: (router: ReturnType<typeof useChatRouter>) =>
        router.updateUrlForChat('abc'),
      path: '/chat/abc',
    },
    {
      name: 'local chat',
      update: (router: ReturnType<typeof useChatRouter>) =>
        router.updateUrlForLocalChat('abc'),
      path: '/chat/local/abc',
    },
    {
      name: 'project',
      update: (router: ReturnType<typeof useChatRouter>) =>
        router.updateUrlForProject('project-1'),
      path: '/project/project-1',
    },
  ])(
    'preserves unconsumed message markers when routing to $name',
    ({ update, path }) => {
      mockUseRouter.mockReturnValue({
        isReady: true,
        query: {},
        pathname: '/newchat',
      })
      const hash = `#send=${Buffer.from('Hello 👋').toString('base64')}`
      window.history.replaceState(
        { retained: true },
        '',
        `/newchat?q=fallback${hash}`,
      )
      const { result } = renderHook(() => useChatRouter())
      act(() => update(result.current))
      expect(window.location.pathname).toBe(path)
      expect(window.location.hash).toBe(hash)
      expect(new URLSearchParams(window.location.search).get('q')).toBe(
        'fallback',
      )
      expect(window.history.state).toEqual({
        retained: true,
        as: `${path}?q=fallback${hash}`,
        url: `${path}?q=fallback${hash}`,
      })
    },
  )

  it('parses initialChatId and detects local chat URL', () => {
    mockUseRouter.mockReturnValue({
      isReady: true,
      query: { chatId: 'chat-123' },
      pathname: '/chat/local/[chatId]',
    })

    const { result } = renderHook(() => useChatRouter())
    expect(result.current.isRouterReady).toBe(true)
    expect(result.current.initialChatId).toBe('chat-123')
    expect(result.current.isLocalChatUrl).toBe(true)
  })

  it('updates URL using history.replaceState', () => {
    mockUseRouter.mockReturnValue({
      isReady: true,
      query: {},
      pathname: '/chat/[chatId]',
    })

    const replaceSpy = vi.spyOn(window.history, 'replaceState')

    // Start at '/'
    window.history.replaceState({}, '', '/')

    const { result } = renderHook(() => useChatRouter())

    act(() => {
      result.current.updateUrlForChat('abc')
    })

    expect(replaceSpy).toHaveBeenCalled()
    expect(window.location.pathname).toBe('/chat/abc')
  })

  it('does not call replaceState if path is unchanged', () => {
    mockUseRouter.mockReturnValue({
      isReady: true,
      query: {},
      pathname: '/chat/[chatId]',
    })

    const replaceSpy = vi.spyOn(window.history, 'replaceState')

    window.history.replaceState({}, '', '/chat/abc')

    const { result } = renderHook(() => useChatRouter())

    const callsBefore = replaceSpy.mock.calls.length

    act(() => {
      result.current.updateUrlForChat('abc')
    })

    // updateUrlForChat should not add any new replaceState calls
    expect(replaceSpy.mock.calls.length).toBe(callsBefore)
  })
})
