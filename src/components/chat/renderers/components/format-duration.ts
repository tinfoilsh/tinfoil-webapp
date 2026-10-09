/** "4.7 seconds" under a minute, "1.4 minutes" otherwise. */
export function formatDurationLabel(seconds: number): string {
  return seconds < 60
    ? `${seconds.toFixed(1)} seconds`
    : `${(seconds / 60).toFixed(1)} minutes`
}
