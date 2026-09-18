export function isSearchableChat(chat: {
  isBlankChat?: boolean
  isTemporary?: boolean
  decryptionFailed?: boolean
  dataCorrupted?: boolean
}): boolean {
  return (
    !chat.isBlankChat &&
    !chat.isTemporary &&
    !chat.decryptionFailed &&
    !chat.dataCorrupted
  )
}
