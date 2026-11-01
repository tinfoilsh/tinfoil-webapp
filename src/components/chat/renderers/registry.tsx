import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type { InputRenderer, MessageRenderer, UIProvider } from './types'

class RendererRegistry {
  private messageRenderers: MessageRenderer[] = []
  private inputRenderers: InputRenderer[] = []
  private providers: Map<string, UIProvider> = new Map()
  private defaultMessageRenderer: MessageRenderer | null = null
  private defaultInputRenderer: InputRenderer | null = null
  private version = 0

  registerMessageRenderer(renderer: MessageRenderer) {
    // Remove existing renderer with same id to prevent duplicates
    this.messageRenderers = this.messageRenderers.filter(
      (r) => r.id !== renderer.id,
    )
    this.messageRenderers.unshift(renderer)
  }

  registerInputRenderer(renderer: InputRenderer) {
    // Remove existing renderer with same id to prevent duplicates
    this.inputRenderers = this.inputRenderers.filter(
      (r) => r.id !== renderer.id,
    )
    this.inputRenderers.unshift(renderer)
  }

  registerProvider(provider: UIProvider) {
    // If provider already exists, remove its old renderers first
    const existingProvider = this.providers.get(provider.id)
    if (existingProvider) {
      this.messageRenderers = this.messageRenderers.filter(
        (r) => r.id !== existingProvider.messageRenderer.id,
      )
      this.inputRenderers = this.inputRenderers.filter(
        (r) => r.id !== existingProvider.inputRenderer.id,
      )
      // Delete and re-add to ensure correct insertion order for precedence
      this.providers.delete(provider.id)
    }

    this.providers.set(provider.id, provider)
    this.registerMessageRenderer(provider.messageRenderer)
    this.registerInputRenderer(provider.inputRenderer)
  }

  setDefaultMessageRenderer(renderer: MessageRenderer) {
    this.defaultMessageRenderer = renderer
  }

  setDefaultInputRenderer(renderer: InputRenderer) {
    this.defaultInputRenderer = renderer
  }

  getMessageRenderer(message: Message, model: BaseModel): MessageRenderer {
    const renderer = this.messageRenderers.find((r) =>
      r.canRender(message, model),
    )
    // Return found renderer or default (which should always be set)
    // If neither exists, it's a configuration error
    if (!renderer && !this.defaultMessageRenderer) {
      throw new Error('No default message renderer configured')
    }
    return renderer || this.defaultMessageRenderer!
  }

  getInputRenderer(model: BaseModel): InputRenderer {
    const renderer = this.inputRenderers.find((r) => r.canRender(model))
    // Return found renderer or default (which should always be set)
    // If neither exists, it's a configuration error
    if (!renderer && !this.defaultInputRenderer) {
      throw new Error('No default input renderer configured')
    }
    return renderer || this.defaultInputRenderer!
  }

  getProvider(model: BaseModel): UIProvider | null {
    // Iterate in reverse to give precedence to most recently registered providers
    const providersArray = Array.from(this.providers.values()).reverse()
    for (const provider of providersArray) {
      // Reset lastIndex to prevent issues with global/sticky regex flags
      provider.modelPattern.lastIndex = 0
      if (provider.modelPattern.test(model.id)) {
        return provider
      }
    }
    return null
  }

  reset() {
    this.messageRenderers = []
    this.inputRenderers = []
    this.providers.clear()
    this.defaultMessageRenderer = null
    this.defaultInputRenderer = null
    this.version++
  }

  getVersion() {
    return this.version
  }
}

// Module-level singleton instance
// IMPORTANT: This registry is reset on:
// 1. User logout (via performSignoutCleanup in signout-cleanup.ts)
// 2. User switch (via AuthCleanupHandler when different user logs in)
// This prevents renderer/provider state from leaking between user sessions
let registryInstance: RendererRegistry | null = null
let globalVersion = 0

export function getRendererRegistry(): RendererRegistry {
  if (!registryInstance) {
    registryInstance = new RendererRegistry()
  }
  return registryInstance
}

export function resetRendererRegistry(): void {
  if (registryInstance) {
    registryInstance.reset()
  }
  registryInstance = null
  globalVersion++
}

export function getRegistryVersion(): number {
  // Combine global and instance versions to maintain monotonicity
  // globalVersion tracks resets, instance version tracks changes within a session
  return globalVersion + (registryInstance ? registryInstance.getVersion() : 0)
}
