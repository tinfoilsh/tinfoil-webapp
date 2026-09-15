import type { Chat } from './types'
export const isResolvedFavoriteChat = (
  chat: Pick<
    Chat,
    | 'id'
    | 'isBlankChat'
    | 'isTemporary'
    | 'pendingSave'
    | 'dataCorrupted'
    | 'decryptionFailed'
  >,
) =>
  !!chat.id &&
  !chat.isBlankChat &&
  !chat.isTemporary &&
  !chat.pendingSave &&
  !chat.dataCorrupted &&
  !chat.decryptionFailed
export const canRequestChatPin = isResolvedFavoriteChat
