/**
 * Renderer for the static install-funnel assistant message. Picks up
 * messages with `computerUseInstallSuggestion` (committed by the webapp
 * from the toggle's "Ask Tin" handler) and renders the static install card.
 *
 * Distinct from GenUI: the model never emits this; it's a webapp action.
 * The chat-query builder filters these messages so the model never sees
 * them in context.
 */

import { ComputerUseInstallCard } from '../ComputerUseInstallCard'
import type { MessageRenderer } from './types'

export const ComputerUseInstallRenderer: MessageRenderer = {
  id: 'computer-use-install',
  canRender: (message) => message.computerUseInstallSuggestion !== undefined,
  render: ({ message }) => (
    <ComputerUseInstallCard
      reason={message.computerUseInstallSuggestion?.reason}
    />
  ),
}
