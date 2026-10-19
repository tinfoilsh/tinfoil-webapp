export type ChatLoadMoreAction = 'reveal-local' | 'fetch-remote' | 'none'

export function getChatLoadMoreAction(options: {
  loadedChatCount: number
  visibleChatCount: number
  hasRemoteCursor: boolean
  canRetryRemoteInitialization: boolean
}): ChatLoadMoreAction {
  if (options.loadedChatCount > options.visibleChatCount) return 'reveal-local'
  if (options.hasRemoteCursor || options.canRetryRemoteInitialization) {
    return 'fetch-remote'
  }
  return 'none'
}
