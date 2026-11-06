import {
  findSelectableModel,
  getAutoIntelligenceLevels,
  getSelectedModelLabel,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@/config/models'
import { TfChevronDownAnimated } from '@tinfoilsh/tinfoil-icons/animated'

type ModelSelectorTriggerLabelProps = {
  selectedModel: string
  models: BaseModel[]
  autoIntelligence: AutoIntelligenceLevelId
  isOpen: boolean
}

/**
 * Contents of the collapsed model picker trigger. When Auto is selected every
 * intelligence level's label is stacked in the same grid cell with all but the
 * current one invisible, so the trigger keeps the width of the widest label
 * and the menu anchored to it does not shift as the slider moves.
 */
export function ModelSelectorTriggerLabel({
  selectedModel,
  models,
  autoIntelligence,
  isOpen,
}: ModelSelectorTriggerLabelProps) {
  const label = getSelectedModelLabel(selectedModel, models, autoIntelligence)
  if (!label) return null

  return (
    <>
      {findSelectableModel(selectedModel, models)?.auto ? (
        <span className="grid whitespace-nowrap text-right text-xs font-medium">
          {getAutoIntelligenceLevels().map((level) => {
            const isCurrent = level.id === autoIntelligence
            return (
              <span
                key={level.id}
                aria-hidden={!isCurrent}
                className={`col-start-1 row-start-1 ${isCurrent ? '' : 'invisible'}`}
              >
                {level.displayLabel}
              </span>
            )
          })}
        </span>
      ) : (
        <span className="whitespace-nowrap text-xs font-medium">{label}</span>
      )}
      <TfChevronDownAnimated
        className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        aria-hidden="true"
      />
    </>
  )
}
