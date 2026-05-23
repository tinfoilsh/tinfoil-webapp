// Client-only exports for React components
// Import from this file when using these components in client components

// Registry functions (needed by client components)
export { getRegistryVersion, getRendererRegistry } from './registry'

// Default renderers
export { DefaultInputRenderer } from './default/DefaultInputRenderer'
export { DefaultMessageRenderer } from './default/DefaultMessageRenderer'

// Components
export { DocumentList } from './components/DocumentList'
export { MessageActions } from './components/MessageActions'
export { MessageContent } from './components/MessageContent'
export { ThoughtProcess } from './components/ThoughtProcess'

// Initialization function that uses client components
import { ComputerUseConsentRenderer } from './ComputerUseConsentRenderer'
import { ComputerUseInstallRenderer } from './ComputerUseInstallRenderer'
import { ComputerUsePairingRenderer } from './ComputerUsePairingRenderer'
import { ComputerUseSessionRenderer } from './ComputerUseSessionRenderer'
import { DefaultInputRenderer } from './default/DefaultInputRenderer'
import { DefaultMessageRenderer } from './default/DefaultMessageRenderer'
import { getRendererRegistry } from './registry'

export function initializeRenderers(): void {
  const registry = getRendererRegistry()
  registry.setDefaultMessageRenderer(DefaultMessageRenderer)
  registry.setDefaultInputRenderer(DefaultInputRenderer)
  // Inline pairing-handshake card — replaces the modal pairing flow.
  registry.registerMessageRenderer(ComputerUsePairingRenderer)
  // Inline consent prompt — the agent's "I'd like permission to ___" turn.
  registry.registerMessageRenderer(ComputerUseConsentRenderer)
  // Static install funnel — webapp commits this on "Ask Tin" clicks.
  registry.registerMessageRenderer(ComputerUseInstallRenderer)
  // Override for messages carrying a finished/errored computer-use session.
  registry.registerMessageRenderer(ComputerUseSessionRenderer)
}
