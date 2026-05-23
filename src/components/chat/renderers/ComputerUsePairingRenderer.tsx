/**
 * Renderer for the inline pairing-handshake message. Picks up messages with
 * `computerUsePairingCode` / `computerUsePairingStatus` — committed by the
 * webapp the moment the session enters the `pairing` phase, mutated to a
 * terminal status when the user resolves the request in the system tray.
 *
 * Replaces the modal pairing UI; lives in chat alongside the consent +
 * session-record cards so the whole computer-use flow reads as a single
 * conversational sequence.
 */

import { ComputerUsePairingCard } from '../ComputerUsePairingCard'
import type { MessageRenderer } from './types'

export const ComputerUsePairingRenderer: MessageRenderer = {
  id: 'computer-use-pairing',
  canRender: (message) =>
    message.computerUsePairingCode !== undefined ||
    message.computerUsePairingStatus !== undefined,
  render: ({ message }) => (
    <ComputerUsePairingCard
      code={message.computerUsePairingCode}
      status={message.computerUsePairingStatus}
    />
  ),
}
