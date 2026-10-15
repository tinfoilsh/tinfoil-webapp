import type { Chat } from './types'

export function canDeleteAllProjects(isSignedIn: boolean): boolean {
  return isSignedIn
}

export function canTransferProjectData(isPremium: boolean): boolean {
  return isPremium
}

function hasExportableMessages(chat: Chat): boolean {
  return !chat.isBlankChat && chat.messages.length > 0
}

export function filterExportableChats(
  chats: Chat[],
  isPremium: boolean,
): Chat[] {
  return chats.filter(
    (chat) => hasExportableMessages(chat) && (isPremium || !chat.projectId),
  )
}

export function countExcludedProjectChats(
  chats: Chat[],
  isPremium: boolean,
): number {
  if (isPremium) return 0
  return chats.filter(
    (chat) => Boolean(chat.projectId) && hasExportableMessages(chat),
  ).length
}
