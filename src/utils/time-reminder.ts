/**
 * Builds the ephemeral current-time reminder appended to the end of chat
 * requests. Keeping the timestamp out of the system prompt (the first
 * message) preserves server-side prefix caching: only the tail of the
 * prompt changes between turns.
 *
 * Minute granularity (no seconds) so retries and regenerations within the
 * same minute produce byte-identical requests.
 */

const TIME_REMINDER_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
}

export function formatCurrentTimeReminder(now: Date = new Date()): string {
  const dateTime = now.toLocaleString('en-US', TIME_REMINDER_FORMAT)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `<system-reminder>Current time: ${dateTime} (${timezone})</system-reminder>`
}
