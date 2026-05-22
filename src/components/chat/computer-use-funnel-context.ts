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
   * Run the pairing handshake against the local broker. Returns `true` on a
   * successful pairing (the pairing modal handles the code-display flow).
   */
  connect: () => Promise<boolean>
}

export const ComputerUseFunnelContext =
  createContext<ComputerUseFunnelContextValue | null>(null)

export function useComputerUseFunnelContext(): ComputerUseFunnelContextValue | null {
  return useContext(ComputerUseFunnelContext)
}
