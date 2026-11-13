import { getAutoIntelligenceLevels } from '@/config/models'
import {
  ModelSelectorTriggerLabel as SharedModelSelectorTriggerLabel,
  type ModelSelectorTriggerLabelProps,
} from '@tinfoil/chat-ui/model-selector-trigger-label'

export function ModelSelectorTriggerLabel(
  props: Omit<ModelSelectorTriggerLabelProps, 'autoLevels'>,
) {
  return (
    <SharedModelSelectorTriggerLabel
      {...props}
      autoLevels={getAutoIntelligenceLevels()}
    />
  )
}
