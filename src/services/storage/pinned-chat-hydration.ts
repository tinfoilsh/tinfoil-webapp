import type { Chat } from '@/components/chat/types'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import type { StoredChat } from './indexed-db'

export type PinnedChatHydrationResult =
  { status: 'ready'; chat: Chat } | { status: 'invalid' | 'unavailable' }

interface PinnedChatHydrationDependencies {
  downloadChat: (chatId: string) => Promise<StoredChat | null>
}

const defaultDependencies: PinnedChatHydrationDependencies = {
  downloadChat: (chatId) => cloudStorage.downloadChat(chatId),
}

function isInvalidFavoriteChat(
  chat: Pick<
    Chat,
    'isBlankChat' | 'isTemporary' | 'isLocalOnly' | 'dataCorrupted'
  >,
): boolean {
  return Boolean(
    chat.isBlankChat ||
    chat.isTemporary ||
    chat.isLocalOnly ||
    chat.dataCorrupted,
  )
}

function downloadedToChat(chat: StoredChat): Chat {
  return { ...chat, createdAt: new Date(chat.createdAt) }
}

function classifyDownloadedChat(chat: StoredChat): PinnedChatHydrationResult {
  if (isInvalidFavoriteChat(chat)) {
    return { status: 'invalid' }
  }
  if (chat.decryptionFailed) return { status: 'unavailable' }
  return { status: 'ready', chat: downloadedToChat(chat) }
}

export async function hydratePinnedChatById(
  chatId: string,
  dependencies: PinnedChatHydrationDependencies = defaultDependencies,
): Promise<PinnedChatHydrationResult> {
  const downloaded = await dependencies.downloadChat(chatId)
  if (!downloaded) return { status: 'unavailable' }
  return classifyDownloadedChat(downloaded)
}
