import type { Chat } from './types'
type FavoriteChatState = Pick<
  Chat,
  | 'id'
  | 'isBlankChat'
  | 'isTemporary'
  | 'isLocalOnly'
  | 'pendingSave'
  | 'dataCorrupted'
  | 'decryptionFailed'
>
// Favorites are stored with the harness's chats, so a chat kept on this
// device is not listed among them.
export const isResolvedFavoriteChat = (chat: FavoriteChatState) =>
  !!chat.id &&
  !chat.isBlankChat &&
  !chat.isTemporary &&
  !chat.isLocalOnly &&
  !chat.pendingSave &&
  !chat.dataCorrupted &&
  !chat.decryptionFailed
// A chat kept on this device can be pinned only where pinning moves it to
// the cloud first.
export const canRequestChatPin = (
  chat: FavoriteChatState,
  canPinLocalChats = false,
) =>
  (canPinLocalChats || !chat.isLocalOnly) &&
  isResolvedFavoriteChat({ ...chat, isLocalOnly: false })
