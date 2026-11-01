/**
 * Formats a date as a relative time string (e.g., "2h ago", "3d ago")
 */
export function formatRelativeTime(
  date: Date,
  referenceTime = Date.now(),
): string {
  const seconds = Math.floor((referenceTime - date.getTime()) / 1000)

  if (seconds < 60) {
    return `${seconds}s ago`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }

  const weeks = Math.floor(days / 7)
  if (weeks < 5) {
    return `${weeks}w ago`
  }

  if (days >= 365) {
    const years = Math.floor(days / 365)
    return `${years}y ago`
  }

  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

/**
 * The "Updated …" line for a time the harness gave, or null when it gave
 * none, so nothing is shown rather than an invalid date.
 */
export function updatedLabel(
  updatedAt: string | undefined,
  referenceTime = Date.now(),
): string | null {
  const time = Date.parse(updatedAt ?? '')
  if (Number.isNaN(time)) return null
  return `Updated ${formatRelativeTime(new Date(time), referenceTime)}`
}
