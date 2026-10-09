/** "4.7 seconds" under a minute, "1.4 minutes" otherwise. */
export function formatDurationLabel(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10
  return rounded < 60
    ? `${rounded.toFixed(1)} seconds`
    : `${(seconds / 60).toFixed(1)} minutes`
}
