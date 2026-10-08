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
