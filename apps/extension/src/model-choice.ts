import type { Session } from '@tinfoil/chat-client/types'
import { DEFAULT_MODEL } from './config'

// The models the chat service offers and the levels Auto works at.
export type Catalog = Pick<Session, 'models' | 'auto' | 'defaultModel'>

// The model a turn runs on: the one chosen while the service still offers
// it, then the extension's own default, then the service's. Auto works at
// the chosen level while the service offers that, and at its default
// otherwise.
export function turnModel(
  offered: Catalog | null | undefined,
  chosen: { model?: string | null; autoLevel?: string | null },
): { model: string; autoIntelligence?: string } {
  const available = (id: string | null | undefined) =>
    offered?.models.find((model) => model.id === id && !model.deprecated)
  const model =
    available(chosen.model) ??
    available(DEFAULT_MODEL) ??
    available(offered?.defaultModel)
  if (!offered || !model?.auto) return { model: model?.id ?? DEFAULT_MODEL }
  return {
    model: model.id,
    autoIntelligence: offered.auto.levels.some(
      (level) => level.id === chosen.autoLevel,
    )
      ? chosen.autoLevel!
      : offered.auto.default,
  }
}
