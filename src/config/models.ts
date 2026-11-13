import { getView } from '@/services/harness/runtime'
import { selectedModelLabel } from '@tinfoil/chat-client/models'

export {
  findSelectableModel,
  getAutoModel,
  getSelectableChatModels,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@tinfoil/chat-client/models'

export const getAutoIntelligenceLevels = () =>
  getView().session?.auto?.levels ?? []
export const getAutoIntelligenceLevel = (id: string) =>
  getAutoIntelligenceLevels().find((level) => level.id === id)
export const getSelectedModelLabel = (
  id: string,
  models: Parameters<typeof selectedModelLabel>[1],
  level: string,
) => selectedModelLabel(id, models, getAutoIntelligenceLevels(), level)
