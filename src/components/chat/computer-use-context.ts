/**
 * React context that exposes the live computer-use session's approve/cancel
 * handlers + readiness data to the inline `ComputerUseConsentRenderer`
 * (which sits inside the chat message tree, away from where the session hook
 * is held).
 *
 * Renderers normally read only from `message` props. The consent message is
 * different — it has to *drive* the live session (approve/cancel), so it
 * needs to reach the session hook somehow. A context keeps it decoupled
 * from the chat-interface internals; a missing provider degrades the
 * renderer to a read-only history view, which is the right behavior on
 * persisted past sessions.
 */
'use client'

import type { CapabilityManifest, DriverImage } from '@/services/computer-use'
import { createContext, useContext } from 'react'

export interface ComputerUseConsentContextValue {
  /**
   * Approve the consent prompt with the (possibly edited) manifest. Drives
   * the underlying `session.approve()`.
   */
  approve: (manifest: CapabilityManifest) => void
  /** Cancel the session. Drives the underlying `session.cancel()`. */
  cancel: () => void
  /**
   * Ready driver images at consent time. The editor's image dropdown lists
   * these; the inline renderer is supplied them via context because they
   * aren't persisted on the message itself.
   */
  images: DriverImage[]
}

export const ComputerUseConsentContext =
  createContext<ComputerUseConsentContextValue | null>(null)

/**
 * Returns the live session bindings when a session is currently asking for
 * consent — used by `ComputerUseConsentRenderer` to wire the editor's
 * Approve/Cancel. Returns `null` when there's no live session (the renderer
 * then shows a read-only "asked permission" record from history).
 */
export function useComputerUseConsentContext(): ComputerUseConsentContextValue | null {
  return useContext(ComputerUseConsentContext)
}
