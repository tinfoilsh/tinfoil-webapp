import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { useMemo } from 'react'
import { getRegistryVersion, getRendererRegistry } from '../renderers/client'

export function useMessageRenderer(message: Message, model: BaseModel) {
  const version = getRegistryVersion()
  return useMemo(() => {
    const registry = getRendererRegistry()
    return registry.getMessageRenderer(message, model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, model, version])
}

export function useInputRenderer(model: BaseModel) {
  const version = getRegistryVersion()
  return useMemo(() => {
    const registry = getRendererRegistry()
    return registry.getInputRenderer(model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, version])
}

export function useUIProvider(model: BaseModel | null) {
  const version = getRegistryVersion()
  return useMemo(() => {
    if (!model) return null
    const registry = getRendererRegistry()
    return registry.getProvider(model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, version])
}
