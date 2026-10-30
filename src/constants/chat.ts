export const DEFAULT_CHAT_TITLE = 'Untitled'
export const TEMPORARY_CHAT_TITLE = 'Temporary Chat'
export const FORK_TITLE_SUFFIX = ' (fork)'

export function forkChatTitle(sourceTitle: string): string {
  const base = sourceTitle || DEFAULT_CHAT_TITLE
  return base.endsWith(FORK_TITLE_SUFFIX) ? base : `${base}${FORK_TITLE_SUFFIX}`
}
