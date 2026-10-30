import { getView } from '@/services/harness/runtime'
import type { SessionModel } from '@/services/harness/types'

// A model as the harness's session offers it, ready to display. The harness
// selects models and builds inference parameters.
export type BaseModel = SessionModel
export type AutoIntelligenceLevelId = string
export const getAutoIntelligenceLevels = () =>
  getView().session?.auto?.levels ?? []
export const getAutoIntelligenceLevel = (id: string) =>
  getAutoIntelligenceLevels().find((level) => level.id === id)
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
export const getSelectedModelLabel = (
  id: string,
  models: BaseModel[],
  level: string,
) => {
  const model = findSelectableModel(id, models)
  return model?.auto
    ? (getAutoIntelligenceLevel(level)?.displayLabel ?? model.label)
    : model?.label
}
