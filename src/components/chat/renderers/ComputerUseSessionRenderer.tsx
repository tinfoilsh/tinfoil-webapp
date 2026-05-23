/**
 * Message renderer for assistant messages carrying a `computerUseFrames` /
 * `computerUseError` payload — i.e. the synthetic message chat-interface
 * commits when a computer-use session reaches a terminal phase.
 *
 * Renders the frames + final summary (or error banner) in the same shell the
 * live `ComputerUseSessionThread` uses, so the transition from in-flight to
 * archived is visually seamless. The red light is wired to remove THIS
 * message from chat (via `ComputerUseFunnelContext.removeMessage`) so users
 * can drop a failed/stale run from history; without a context (e.g. on
 * reloaded historical chats) the red light degrades to inert.
 */

import { useComputerUseFunnelContext } from '../computer-use-funnel-context'
import { ComputerUseSessionCard } from '../ComputerUseSessionMessage'
import type { MessageRenderer } from './types'

export const ComputerUseSessionRenderer: MessageRenderer = {
  id: 'computer-use-session',
  canRender: (message) =>
    message.computerUseFrames !== undefined ||
    message.computerUseError !== undefined ||
    message.computerUseManifest !== undefined,
  render: ({ message, messageIndex }) => (
    <ComputerUseSessionRecord message={message} messageIndex={messageIndex} />
  ),
}

function ComputerUseSessionRecord({
  message,
  messageIndex,
}: {
  message: import('../types').Message
  messageIndex: number
}) {
  const funnel = useComputerUseFunnelContext()
  return (
    <ComputerUseSessionCard
      frames={message.computerUseFrames ?? []}
      error={message.computerUseError}
      manifest={message.computerUseManifest}
      onRemove={funnel ? () => funnel.removeMessage(messageIndex) : undefined}
    />
  )
}
