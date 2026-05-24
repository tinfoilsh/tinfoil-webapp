/**
 * React context that exposes the live computer-use session's `connect`
 * action to widgets rendered in chat scroll — currently used by the
 * `SuggestInstallingComputerUse` install card so its in-card "Connect"
 * button can drive the existing pairing modal once the user reports the
 * driver is installed.
 *
 * Distinct from `ComputerUseConsentContext` (which is consent-prompt
 * specific). A widget without a provider falls back to a read-only render,
 * which is the right behavior on reloaded historical messages.
 */
'use client'

import { createContext, useContext } from 'react'

export interface ComputerUseFunnelContextValue {
  /**
   * Run the pairing handshake against the local driver. Returns `true` on a
   * successful pairing. The pairing card in chat (or, in fallback mode,
   * the dialog) shows the code while this is in flight.
   */
  connect: () => Promise<boolean>
  /**
   * Cancel an in-flight pairing handshake — aborts the session's
   * pairing-phase work + tears down any pending tray request. Drives the
   * "Cancel pairing" button on the inline pairing card.
   */
  cancelPairing: () => void
  /**
   * Remove the message at `messageIndex` from the current chat. Used by the
   * session-record card's red light so users can drop a failed or stale run
   * from history. Removing the message also implicitly removes it from the
   * model's context — `chat-query-builder` reads from the same array.
   */
  removeMessage: (messageIndex: number) => void
}

export const ComputerUseFunnelContext =
  createContext<ComputerUseFunnelContextValue | null>(null)

export function useComputerUseFunnelContext(): ComputerUseFunnelContextValue | null {
  return useContext(ComputerUseFunnelContext)
}
