import type { Session, SessionModel } from './types'

// A model as the harness's session offers it, ready to display. The harness
// selects models and builds inference parameters.
export type BaseModel = SessionModel
export type AutoIntelligenceLevelId = string
export type AutoIntelligenceLevel = Session['auto']['levels'][number]
export const getAutoModel = (models: BaseModel[]) =>
  models.find((m) => m.auto === true)
/**
 * Real chat models a picker offers below the Auto entry. A deprecated model
 * stays listed only while it is the current selection so the menu agrees with
 * the value it displays for chats that already use it.
 */
export const getSelectableChatModels = (
  models: BaseModel[],
  selectedModel: string | undefined,
): BaseModel[] =>
  models.filter(
    (model) =>
      model.auto !== true &&
      (model.deprecated !== true || model.id === selectedModel),
  )
export const findSelectableModel = (id: string, models: BaseModel[]) =>
  models.find((m) => m.id === id)
export const selectedModelLabel = (
  id: string,
  models: BaseModel[],
  levels: readonly AutoIntelligenceLevel[],
  level: string,
) => {
  const model = findSelectableModel(id, models)
  return model?.auto
    ? (levels.find((entry) => entry.id === level)?.displayLabel ?? model.label)
    : model?.label
}

export type ReasoningEffort = 'low' | 'medium' | 'high'
export const DEFAULT_EFFORT: ReasoningEffort = 'medium'
export const supportsReasoningEffort = (model?: BaseModel | null) =>
  !!model?.reasoning?.effort
export const supportsThinkingToggle = (model?: BaseModel | null) =>
  !!model?.reasoning?.toggle
