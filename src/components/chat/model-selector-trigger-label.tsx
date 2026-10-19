import {
  AUTO_INTELLIGENCE_LEVELS,
  getAutoDisplayName,
  getSelectedModelLabel,
  isAutoModelId,
  type AutoIntelligenceLevelId,
  type BaseModel,
} from '@/config/models'

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
      {isAutoModelId(selectedModel) ? (
        <span className="grid whitespace-nowrap text-right text-xs font-medium">
          {AUTO_INTELLIGENCE_LEVELS.map((level) => {
            const isCurrent = level.id === autoIntelligence
            return (
              <span
                key={level.id}
                aria-hidden={!isCurrent}
                className={`col-start-1 row-start-1 ${isCurrent ? '' : 'invisible'}`}
              >
                {getAutoDisplayName(level.id)}
              </span>
            )
          })}
        </span>
      ) : (
        <span className="whitespace-nowrap text-xs font-medium">{label}</span>
      )}
      <svg
        className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 9l-7 7-7-7"
        />
      </svg>
    </>
  )
}
