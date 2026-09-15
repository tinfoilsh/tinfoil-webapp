import { getView } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'

// Display fields only. The harness selects models and builds inference parameters.
export type BaseModel = {
  modelName: string
  name: string
  nameShort: string
  description: string
  image: string
  type: 'chat'
  chat: boolean
  multimodal?: boolean
  paid?: boolean
  deprecated?: boolean
  experimental?: boolean
  deprecationDate?: string
  isAuto?: boolean
  chatConfig?: {
    attributes?: string[]
    descriptionShort?: string
    reasoningConfig?: {
      supportsEffort?: boolean
      supportsToggle?: boolean
      defaultEnabled?: boolean
    }
  }
}
export type AutoIntelligenceLevelId = string
export type AutoIntelligenceLevel = { id: string; label: string; value: number }
export const AUTO_MODEL_ID = 'auto'
export const isAutoModelId = (id: string) => id === AUTO_MODEL_ID
export const getAutoIntelligenceLevels = (): AutoIntelligenceLevel[] =>
  (getView().session?.auto?.levels ?? []).map((level, value) => ({
    ...level,
    value,
  }))
export const getAutoIntelligenceLevel = (id: string) =>
  getAutoIntelligenceLevels().find((level) => level.id === id) ?? {
    id,
    label: id,
    value: 0,
  }
export const getAutoDisplayName = (id: string) =>
  `Auto · ${getAutoIntelligenceLevel(id).label}`
export function displayModels(session?: Session): BaseModel[] {
  if (!session) return []
  const models: BaseModel[] = session.models.map((m) => ({
    ...m,
    modelName: m.id,
    nameShort: m.nameShort ?? m.name,
    description: m.description ?? '',
    image: m.image ?? '',
    type: 'chat',
    chat: true,
    chatConfig: {
      attributes: m.attributes ?? [],
      descriptionShort: m.descriptionShort ?? '',
      reasoningConfig: m.reasoning
        ? {
            supportsEffort: m.reasoning.effort,
            supportsToggle: m.reasoning.toggle,
            defaultEnabled: m.reasoning.defaultEnabled,
          }
        : undefined,
    },
  }))
  if (session.auto)
    models.unshift({
      modelName: 'auto',
      name: 'Auto',
      nameShort: 'Auto',
      image: '',
      description: '',
      type: 'chat',
      chat: true,
      isAuto: true,
      multimodal: session.auto.multimodal,
    })
  return models
}
export const getAutoModel = (models: BaseModel[]) =>
  models.find((m) => m.isAuto)
export const findSelectableModel = (id: string, models: BaseModel[]) =>
  models.find((m) => m.modelName === id)
export const getSelectedModelLabel = (
  id: string,
  models: BaseModel[],
  level: string,
) =>
  isAutoModelId(id)
    ? getAutoDisplayName(level)
    : findSelectableModel(id, models)?.name
export const getKnownModelDisplayName = (id: string) =>
  findSelectableModel(id, displayModels(getView().session))?.name
