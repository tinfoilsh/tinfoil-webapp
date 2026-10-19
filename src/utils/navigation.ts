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

// The sections the catch-all route renders; it shows its not-found page for
// any other path.
const CATCH_ALL_SECTIONS = ['chat', 'project', 'share']
export function isCatchAllSection(slug: string | string[] | undefined) {
  const section = Array.isArray(slug) ? slug[0] : slug
  return !!section && CATCH_ALL_SECTIONS.includes(section)
}

export function isLocalNewChatStorage(
  storage: string | string[] | undefined,
): boolean {
  return storage === LOCAL_NEW_CHAT_STORAGE
}
