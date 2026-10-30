const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE

/** Whole seconds as "8s", "3m 33s" or "1h 4m", leaving out a zero part. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < SECONDS_PER_MINUTE) return `${total}s`
  const hours = Math.floor(total / SECONDS_PER_HOUR)
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  const rest = total % SECONDS_PER_MINUTE
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}
