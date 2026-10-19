import { getChatLoadMoreAction } from '@/components/chat/sidebar-pagination'
import { describe, expect, it } from 'vitest'

describe('getChatLoadMoreAction', () => {
  it('reveals local hydration in page increments before fetching remotely', () => {
    expect(
      getChatLoadMoreAction({
        loadedChatCount: 50,
        visibleChatCount: 20,
        hasRemoteCursor: true,
        canRetryRemoteInitialization: false,
      }),
    ).toBe('reveal-local')
    expect(
      getChatLoadMoreAction({
        loadedChatCount: 50,
        visibleChatCount: 60,
        hasRemoteCursor: true,
        canRetryRemoteInitialization: false,
      }),
    ).toBe('fetch-remote')
  })

  it('fetches remotely to retry cursor initialization', () => {
    expect(
      getChatLoadMoreAction({
        loadedChatCount: 20,
        visibleChatCount: 20,
        hasRemoteCursor: false,
        canRetryRemoteInitialization: true,
      }),
    ).toBe('fetch-remote')
  })

  it('does nothing when local and remote history are exhausted', () => {
    expect(
      getChatLoadMoreAction({
        loadedChatCount: 20,
        visibleChatCount: 20,
        hasRemoteCursor: false,
        canRetryRemoteInitialization: false,
      }),
    ).toBe('none')
  })
})
