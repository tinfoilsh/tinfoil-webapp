import { getAutoIntelligenceLevels } from '@/config/models'
import {
  ModelSelector as SharedModelSelector,
  type ModelSelectorProps,
} from '@tinfoil/chat-ui/model-selector'

export function ModelSelector(props: Omit<ModelSelectorProps, 'autoLevels'>) {
  return (
    <SharedModelSelector {...props} autoLevels={getAutoIntelligenceLevels()} />
  )
}
