export function isSearchableChat(chat: {
  isBlankChat?: boolean
  isTemporary?: boolean
}): boolean {
  return !chat.isBlankChat && !chat.isTemporary
}
