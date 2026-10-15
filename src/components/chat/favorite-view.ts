import type { Chat } from './types'
// Favorites are stored with the harness's chats, so a chat kept on this
// device cannot be pinned.
export const isResolvedFavoriteChat = (
  chat: Pick<
    Chat,
    | 'id'
    | 'isBlankChat'
    | 'isTemporary'
    | 'isLocalOnly'
    | 'pendingSave'
    | 'dataCorrupted'
    | 'decryptionFailed'
  >,
) =>
  !!chat.id &&
  !chat.isBlankChat &&
  !chat.isTemporary &&
  !chat.isLocalOnly &&
  !chat.pendingSave &&
  !chat.dataCorrupted &&
  !chat.decryptionFailed
export const canRequestChatPin = isResolvedFavoriteChat
