/**
 * Tiny platform glyph used wherever a guest OS needs a visual marker (consent
 * dialog, toolbar title, sandbox config). Lifted out to break a circular
 * dependency between the toolbar, the session card, and the popovers.
 */

'use client'

import { type GuestOS } from '@/services/computer-use'
import { FaApple, FaLinux } from 'react-icons/fa'

export function OSBadge({ os }: { os: GuestOS }) {
  const Icon = os === 'mac' ? FaApple : FaLinux
  return (
    <span
      className="text-content-muted"
      role="img"
      aria-label={os === 'mac' ? 'macOS' : 'Linux'}
      title={os === 'mac' ? 'macOS' : 'Linux'}
    >
      <Icon size={12} />
    </span>
  )
}
