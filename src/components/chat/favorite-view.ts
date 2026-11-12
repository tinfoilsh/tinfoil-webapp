import type { Chat } from './types'
type FavoriteChatState = Pick<
  Chat,
  'id' | 'isBlankChat' | 'isTemporary' | 'isLocalOnly' | 'pendingSave'
>
// A chat listed among the favorites: one saved, in the cloud or on this
// device, that is not temporary.
export const isResolvedFavoriteChat = (chat: FavoriteChatState) =>
  !!chat.id && !chat.isBlankChat && !chat.isTemporary && !chat.pendingSave
// A chat kept on this device can be pinned only where this device keeps
// favorites.
export const canRequestChatPin = (
  chat: FavoriteChatState,
  canPinLocalChats = false,
) => (canPinLocalChats || !chat.isLocalOnly) && isResolvedFavoriteChat(chat)
