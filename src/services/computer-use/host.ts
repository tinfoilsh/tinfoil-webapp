/**
 * Host-environment gating for computer-use.
 *
 * The driver runs on the user's own machine and the MVP only supports a macOS
 * host (Apple Virtualization via `tart`). The chat runs in the browser on that
 * same machine, so the browser's OS *is* the host OS — if it isn't macOS, the
 * driver can't exist here and the tool should not be offered at all.
 */

/** True when the browser is running on macOS (and not iOS/iPadOS). */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false

  // Prefer the modern, spoofing-resistant hint when present.
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData
  if (uaData?.platform) return uaData.platform === 'macOS'

  const ua = navigator.userAgent || ''
  // iPadOS reports a Mac-like platform; exclude touch iOS devices explicitly.
  if (/iPhone|iPad|iPod/i.test(ua)) return false
  const platform = navigator.platform || ua
  return /Mac/i.test(platform)
}
