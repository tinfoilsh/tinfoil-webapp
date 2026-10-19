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
  // Explicit hour cycle so OS-level 24-hour preferences cannot alter the
  // fixed format on engines that let them leak into explicit locales.
  hour12: true,
}

// Cached because Intl.DateTimeFormat construction is expensive and this
// runs on every chat request build.
const timeReminderFormatter = new Intl.DateTimeFormat(
  'en-US',
  TIME_REMINDER_FORMAT,
)

export function formatCurrentTimeReminder(now: Date = new Date()): string {
  const dateTime = timeReminderFormatter.format(now)
  const timezone = timeReminderFormatter.resolvedOptions().timeZone
  return `<system-reminder>Current time: ${dateTime} (${timezone})</system-reminder>`
}
