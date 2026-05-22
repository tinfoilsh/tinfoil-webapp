/**
 * Message renderer for assistant messages carrying a `computerUseFrames` /
 * `computerUseError` payload — i.e. the synthetic message chat-interface
 * commits when a computer-use session reaches a terminal phase.
 *
 * Renders the frames + final summary (or error banner) in the same shell the
 * live `ComputerUseSessionThread` uses, so the transition from in-flight to
 * archived is visually seamless.
 */

import { ComputerUseSessionCard } from '../ComputerUseSessionMessage'
import type { MessageRenderer } from './types'

export const ComputerUseSessionRenderer: MessageRenderer = {
  id: 'computer-use-session',
  canRender: (message) =>
    message.computerUseFrames !== undefined ||
    message.computerUseError !== undefined ||
    message.computerUseManifest !== undefined,
  render: ({ message }) => (
    <ComputerUseSessionCard
      frames={message.computerUseFrames ?? []}
      finalText={message.content || undefined}
      error={message.computerUseError}
      manifest={message.computerUseManifest}
    />
  ),
}
