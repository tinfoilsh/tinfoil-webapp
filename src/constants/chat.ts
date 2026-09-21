export const DEFAULT_CHAT_TITLE = 'Untitled'
export const TEMPORARY_CHAT_TITLE = 'Temporary Chat'
export const FORK_TITLE_SUFFIX = ' (fork)'

export function forkChatTitle(sourceTitle: string): string {
  const base = sourceTitle || DEFAULT_CHAT_TITLE
  return base.endsWith(FORK_TITLE_SUFFIX) ? base : `${base}${FORK_TITLE_SUFFIX}`
}

/**
 * Request header carrying the chat id so the router's safeguards submission
 * can identify a conversation. A continued conversation is then only ever
 * counted once toward an acceptable use policy violation, and a flag can be
 * linked back to the chat. The router strips it before the model sees it.
 */
export const CONVERSATION_ID_HEADER = 'X-Tinfoil-Conversation-Id'
