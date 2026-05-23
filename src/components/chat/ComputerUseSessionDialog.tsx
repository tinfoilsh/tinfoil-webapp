/**
 * Modal hook-point for computer-use session steps that need focused attention.
 *
 * Currently a no-op: both pairing AND consent render inline in chat (see
 * `ComputerUsePairingRenderer` and `ComputerUseConsentRenderer`). Kept as a
 * component shell so a future step that genuinely needs a modal (e.g. an
 * un-skippable confirmation) has an obvious place to land.
 */

'use client'

import { type useComputerUseSession } from '@/services/computer-use'

type SessionApi = ReturnType<typeof useComputerUseSession>

export function ComputerUseSessionDialog(_: { session: SessionApi }) {
  return null
}
