import { PINNED_CHAT_IDS_CHANGED_EVENT } from '@/constants/settings-events'
import { USER_PREFS_PINNED_CHAT_IDS } from '@/constants/storage-keys'

export const MAX_PINNED_CHATS = 20

interface FavoriteChatState {
  id: string
  isBlankChat?: boolean
  isTemporary?: boolean
  isLocalOnly?: boolean
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  pendingSave?: boolean
}

export function canRequestChatPin(chat: FavoriteChatState): boolean {
  return Boolean(
    chat.id.trim().length > 0 &&
    !chat.isBlankChat &&
    !chat.isTemporary &&
    !chat.decryptionFailed &&
    !chat.dataCorrupted &&
    !chat.pendingSave,
  )
}

export function isResolvedFavoriteChat(chat: FavoriteChatState): boolean {
  return Boolean(
    chat.id.trim().length > 0 &&
    !chat.isBlankChat &&
    !chat.isTemporary &&
    !chat.isLocalOnly &&
    !chat.decryptionFailed &&
    !chat.dataCorrupted,
  )
}

export function normalizePinnedChatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const ids: string[] = []
  for (const valueId of value) {
    if (typeof valueId !== 'string') {
      continue
    }
    const id = valueId.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length === MAX_PINNED_CHATS) break
  }
  return ids
}

export function loadPinnedChatIds(): string[] | undefined {
  if (typeof window === 'undefined') return undefined
  const stored = localStorage.getItem(USER_PREFS_PINNED_CHAT_IDS)
  if (stored === null) return undefined
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? normalizePinnedChatIds(parsed) : undefined
  } catch {
    return undefined
  }
}

export function savePinnedChatIds(pinnedChatIds: readonly string[]): string[] {
  const normalized = normalizePinnedChatIds(pinnedChatIds)
  localStorage.setItem(USER_PREFS_PINNED_CHAT_IDS, JSON.stringify(normalized))
  window.dispatchEvent(
    new CustomEvent(PINNED_CHAT_IDS_CHANGED_EVENT, {
      detail: { pinnedChatIds: normalized },
    }),
  )
  return normalized
}

export function addPinnedChatId(
  pinnedChatIds: readonly string[],
  chatId: string,
): string[] {
  return normalizePinnedChatIds([chatId, ...pinnedChatIds])
}

export function removePinnedChatIds(
  pinnedChatIds: readonly string[],
  chatIds: readonly string[],
): string[] {
  const removed = new Set(chatIds)
  return normalizePinnedChatIds(pinnedChatIds.filter((id) => !removed.has(id)))
}
