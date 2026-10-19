const MAX_TIMESTAMP = 9999999999999

function extractReverseTimestamp(conversationId?: string): number | undefined {
  if (!conversationId) return undefined
  const [reversePart] = conversationId.split('_')
  if (!reversePart) return undefined
  const parsed = Number.parseInt(reversePart, 10)
  if (Number.isNaN(parsed)) {
    return undefined
  }
  const timestamp = MAX_TIMESTAMP - parsed
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  return timestamp
}

export function ensureValidISODate(
  value: string | number | Date | null | undefined,
  conversationId?: string,
): string {
  if (value !== undefined && value !== null) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString()
    }
  }

  const fallback = extractReverseTimestamp(conversationId)
  if (fallback !== undefined) {
    const date = new Date(fallback)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }

  return new Date().toISOString()
}

function toEpochMs(value: unknown): number | null {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  return Number.isNaN(time) ? null : time
}

/**
 * A chat's last conversation activity in epoch milliseconds: the later of
 * its creation time and its newest message timestamp. Every client orders
 * the chat list by it, and the sync enclave derives the same value so the
 * server pages chats in that order. Renaming a chat, changing its settings,
 * moving it, or re-uploading it therefore never moves it in the list.
 * Summary rows carry no messages, so they use the value recorded when the
 * summary was written.
 */
export function chatActivityTime(chat: {
  createdAt?: Date | string
  messages?: ReadonlyArray<{ timestamp?: Date | string }>
  isMetadataOnly?: boolean
  activityAt?: string
}): number {
  if (chat.isMetadataOnly) {
    const recorded = toEpochMs(chat.activityAt)
    if (recorded !== null) return recorded
  }
  let latest = toEpochMs(chat.createdAt) ?? 0
  for (const message of chat.messages ?? []) {
    const time = toEpochMs(message.timestamp)
    if (time !== null && time > latest) latest = time
  }
  return latest
}
