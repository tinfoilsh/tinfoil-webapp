import {
  findSelectableModel,
  selectedModelLabel,
  type AutoIntelligenceLevel,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@tinfoil/chat-client/models'
import { TfChevronDownAnimated } from '@tinfoilsh/tinfoil-icons/animated'

export type ModelSelectorTriggerLabelProps = {
  selectedModel: string
  models: BaseModel[]
  // The levels Auto works at, as the session offers them.
  autoLevels: readonly AutoIntelligenceLevel[]
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
  autoLevels,
  autoIntelligence,
  isOpen,
}: ModelSelectorTriggerLabelProps) {
  const label = selectedModelLabel(
    selectedModel,
    models,
    autoLevels,
    autoIntelligence,
  )
  if (!label) return null

  return (
    <>
      {findSelectableModel(selectedModel, models)?.auto ? (
        <span className="grid whitespace-nowrap text-right text-xs font-medium">
          {autoLevels.map((level) => {
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
