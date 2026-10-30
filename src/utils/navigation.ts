import type { MouseEvent } from 'react'

type LinkClick = Pick<
  MouseEvent<HTMLAnchorElement>,
  'altKey' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

interface ChatPathOptions {
  isLocalOnly?: boolean
  projectId?: string
}

export const NEW_CHAT_STORAGE_QUERY_KEY = 'storage'
export const LOCAL_NEW_CHAT_STORAGE = 'local'

export function isPlainPrimaryClick(event: LinkClick): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

export function getChatPath(
  chatId: string,
  { isLocalOnly = false, projectId }: ChatPathOptions = {},
): string {
  if (projectId) return `/project/${projectId}/chat/${chatId}`
  if (isLocalOnly) return `/chat/local/${chatId}`
  return `/chat/${chatId}`
}

export function getNewChatPath({
  isLocalOnly = false,
  projectId,
}: ChatPathOptions = {}): string {
  if (projectId) return `/project/${projectId}`
  if (isLocalOnly) {
    return `/newchat?${NEW_CHAT_STORAGE_QUERY_KEY}=${LOCAL_NEW_CHAT_STORAGE}`
  }
  return '/newchat'
}

export function isLocalNewChatStorage(
  storage: string | string[] | undefined,
): boolean {
  return storage === LOCAL_NEW_CHAT_STORAGE
}
